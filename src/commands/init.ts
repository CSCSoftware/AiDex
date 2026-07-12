/**
 * init command - Initialize AiDex for a project
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename, extname, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { INDEX_DIR } from '../constants.js';
import { invalidateGlobalCache } from './global/global-query.js';
import type { IndexResult } from '../embeddings/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Run embedding in a fully isolated child process (spawn, not fork) so an
 * ONNX OOM crash kills only the worker — the MCP server stays alive.
 * Communication via stdin/stdout JSON. Timeout: 10 minutes per project.
 */
function indexProjectInWorker(projectPath: string, force = false): Promise<IndexResult> {
    return new Promise((resolve, reject) => {
        const workerPath = join(__dirname, '..', 'embeddings', 'embed-worker.js');
        const child = spawn(process.execPath, [workerPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Embedding timed out after 10 minutes'));
        }, 10 * 60 * 1000);

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            try {
                const msg = JSON.parse(stdout.trim());
                if (msg.ok) {
                    resolve({ embedded: msg.embedded, skipped: msg.skipped, removed: msg.removed, durationMs: msg.durationMs });
                } else {
                    reject(new Error(msg.error ?? `Worker failed (exit ${code})`));
                }
            } catch {
                const errDetail = stderr.split('\n')[0].slice(0, 200);
                reject(new Error(`Worker exited with code ${code}${errDetail ? ': ' + errDetail : ' (likely OOM)'}`));
            }
        });

        // Send the request via stdin and close it so the worker knows input is done.
        child.stdin.write(JSON.stringify({ projectPath, force }));
        child.stdin.end();
    });
}

/**
 * Compute a short (16-char) SHA256 hash of content.
 * Used consistently across init, update, and session for file/line hashing.
 */
export function shortHash(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

import { createDatabase, createQueries, type AiDexDatabase, type Queries } from '../db/index.js';
import { extract, getSupportedExtensions } from '../parser/index.js';
import { globalDbExists, readProjectStats, openGlobalDatabase } from '../db/global-database.js';

// ============================================================
// Types
// ============================================================

export interface InitParams {
    path: string;
    name?: string;
    languages?: string[];
    exclude?: string[];
    fresh?: boolean;  // Force fresh re-index (delete all existing data)
    store_bodies?: boolean;  // Store full method bodies in DB (vorbereitend für Embeddings)
    embeddings?: boolean;    // Implies store_bodies=true (Embeddings brauchen Bodies)
    // LLM-layer config (v1.25). Persisted per project in global.db.
    llm_endpoint?: string;
    llm_model?: string;
    llm_send_code?: boolean;
}

export interface InitResult {
    success: boolean;
    indexPath: string;
    filesIndexed: number;
    filesSkipped: number;  // Unchanged files
    filesRemoved: number;  // Files removed due to exclude patterns
    itemsFound: number;
    methodsFound: number;
    typesFound: number;
    durationMs: number;
    errors: string[];
    embeddings?: {
        embedded: number;
        skipped: number;
        removed: number;
        durationMs: number;
    };
}

// ============================================================
// Default patterns
// ============================================================

export const DEFAULT_EXCLUDE = [
    // Package managers
    '**/node_modules/**',
    '**/vendor/**',          // PHP Composer, Go
    '**/vendor/bundle/**',   // Ruby Bundler
    // Build output
    '**/bin/**',
    '**/obj/**',
    '**/bld/**',             // Alternative build folder
    '**/build/**',
    '**/dist/**',
    '**/out/**',             // VS Code, some TS configs
    '**/target/**',          // Rust, Maven
    '**/Debug/**',           // Visual Studio
    '**/Release/**',         // Visual Studio
    '**/x64/**',             // Visual Studio
    '**/x86/**',             // Visual Studio
    '**/[Aa][Rr][Mm]/**',    // Visual Studio ARM
    '**/[Aa][Rr][Mm]64/**',  // Visual Studio ARM64
    '**/__pycache__/**',     // Python
    '**/.pyc',               // Python bytecode
    '**/venv/**',            // Python virtual env
    '**/.venv/**',           // Python virtual env
    '**/env/**',             // Python virtual env
    '**/*.egg-info/**',      // Python package metadata
    '**/site-packages/**',   // Python installed packages
    '**/Lib/**',             // Embedded Python standard library
    '**/fdk-aac/**',         // Fraunhofer AAC codec (external)
    // IDE/Editor
    '**/.git/**',
    '**/.vs/**',
    '**/.idea/**',
    '**/.vscode/**',
    // Framework-specific
    '**/.next/**',           // Next.js
    '**/coverage/**',        // Test coverage
    '**/tmp/**',             // Ruby, temp files
    '**/.terraform/**',      // Terraform downloaded modules + state cache
    // Generated files
    '**/*.min.js',
    '**/*.generated.*',
    '**/*.g.cs',             // C# source generators
    '**/*.Designer.cs',      // WinForms designer
];

// ============================================================
// .gitignore support
// ============================================================

export function readGitignore(projectPath: string): string[] {
    const gitignorePath = join(projectPath, '.gitignore');
    if (!existsSync(gitignorePath)) return [];

    const content = readFileSync(gitignorePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))  // Skip comments, empty lines, and negation patterns
        .map(pattern => {
            // Glob-kompatibel machen
            if (pattern.endsWith('/')) {
                return `**/${pattern}**`;  // Verzeichnis: foo/ → **/foo/**
            }
            if (!pattern.includes('/') && !pattern.startsWith('*')) {
                return `**/${pattern}`;    // Datei/Ordner: foo → **/foo
            }
            return pattern;
        });
}

function parseIgnoreFile(filePath: string): string[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
        .map(pattern => {
            if (pattern.endsWith('/')) return `**/${pattern}**`;
            if (!pattern.includes('/') && !pattern.startsWith('*')) return `**/${pattern}`;
            return pattern;
        });
}

// Binary/asset extensions always excluded from embeddings
const EMBED_BINARY_EXCLUDE = [
    '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.ico', '**/*.webp',
    '**/*.svg', '**/*.bmp', '**/*.tiff', '**/*.exr', '**/*.psd', '**/*.afphoto',
    '**/*.mp3', '**/*.mp4', '**/*.wav', '**/*.ogg', '**/*.webm', '**/*.flac',
    '**/*.m4a', '**/*.aac',
    '**/*.dll', '**/*.so', '**/*.dylib', '**/*.exe', '**/*.bin', '**/*.obj',
    '**/*.pdb', '**/*.lib', '**/*.a', '**/*.o',
    '**/*.zip', '**/*.tar', '**/*.gz', '**/*.rar', '**/*.7z',
    '**/*.pdf', '**/*.doc', '**/*.docx', '**/*.xls', '**/*.xlsx',
    '**/*.ttf', '**/*.otf', '**/*.woff', '**/*.woff2', '**/*.eot',
    '**/*.fbx', '**/*.obj', '**/*.glb', '**/*.gltf', '**/*.blend',
    '**/*.onnx', '**/*.pt', '**/*.nn', '**/*.tflite',
    '**/*.meta', '**/*.asset', '**/*.prefab', '**/*.unity', '**/*.mat',
    '**/*.lock',
];

/**
 * Returns embed-exclude patterns for a project.
 * Falls back to .aidexignore patterns if no .aidexembedignore exists.
 * Always adds binary/asset exclusions on top.
 */
export function readAidexEmbedIgnore(projectPath: string): string[] {
    const embedIgnorePath = join(projectPath, '.aidexembedignore');
    const base = existsSync(embedIgnorePath)
        ? parseIgnoreFile(embedIgnorePath)
        : parseIgnoreFile(join(projectPath, '.aidexignore'));
    return [...EMBED_BINARY_EXCLUDE, ...base];
}

// ============================================================
// File type detection
// ============================================================

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.astro',
    '.cs', '.rs', '.py', '.pyw',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
    '.java', '.go', '.php', '.rb', '.rake',
    '.tf', '.tfvars', '.hcl',
    '.kt', '.kts', '.swift',
]);

const CONFIG_EXTENSIONS = new Set([
    '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env', '.config',
    '.eslintrc', '.prettierrc', '.babelrc', '.editorconfig'
]);

const DOC_EXTENSIONS = new Set([
    '.md', '.txt', '.rst', '.adoc', '.doc', '.docx', '.pdf'
]);

const ASSET_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm',
    '.zip', '.tar', '.gz', '.rar'
]);

type FileType = 'dir' | 'code' | 'config' | 'doc' | 'asset' | 'test' | 'other';

function detectFileType(filePath: string): FileType {
    const ext = extname(filePath).toLowerCase();
    const lowerPath = filePath.toLowerCase();

    // Check for test files first (before code check)
    if (lowerPath.includes('.test.') || lowerPath.includes('.spec.') ||
        lowerPath.includes('_test.') || lowerPath.includes('_spec.') ||
        lowerPath.includes('/test/') || lowerPath.includes('/tests/') ||
        lowerPath.includes('/__tests__/')) {
        return 'test';
    }

    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (CONFIG_EXTENSIONS.has(ext)) return 'config';
    if (DOC_EXTENSIONS.has(ext)) return 'doc';
    if (ASSET_EXTENSIONS.has(ext)) return 'asset';

    return 'other';
}

// ============================================================
// Main init function
// ============================================================

export async function init(params: InitParams): Promise<InitResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Validate project path
    if (!existsSync(params.path)) {
        return {
            success: false,
            indexPath: '',
            filesIndexed: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            itemsFound: 0,
            methodsFound: 0,
            typesFound: 0,
            durationMs: Date.now() - startTime,
            errors: [`Project path does not exist: ${params.path}`],
        };
    }

    const stat = statSync(params.path);
    if (!stat.isDirectory()) {
        return {
            success: false,
            indexPath: '',
            filesIndexed: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            itemsFound: 0,
            methodsFound: 0,
            typesFound: 0,
            durationMs: Date.now() - startTime,
            errors: [`Path is not a directory: ${params.path}`],
        };
    }

    // Create index directory
    const indexDir = join(params.path, INDEX_DIR);
    if (!existsSync(indexDir)) {
        mkdirSync(indexDir, { recursive: true });
    }

    const dbPath = join(indexDir, 'index.db');
    const projectName = params.name ?? basename(params.path);

    // Determine if incremental (default) or fresh re-index
    const dbExists = existsSync(dbPath);
    const incremental = dbExists && !params.fresh;

    // Create database (incremental keeps existing data)
    const db = createDatabase(dbPath, projectName, params.path, incremental);
    const queries = createQueries(db);

    // Determine store_bodies setting (precedence: explicit param > embeddings flag > metadata > default false)
    const storedFlag = db.getMetadata('store_bodies');
    const storeBodies =
        params.store_bodies === true || params.embeddings === true
            ? true
            : params.store_bodies === false
                ? false
                : storedFlag === '1';
    db.setMetadata('store_bodies', storeBodies ? '1' : '0');

    // Build glob pattern for supported files
    const extensions = getSupportedExtensions();
    const patterns = extensions.map(ext => `**/*${ext}`);

    // Merge exclude patterns (including .gitignore)
    const gitignorePatterns = readGitignore(params.path);
    const exclude = [...DEFAULT_EXCLUDE, ...gitignorePatterns, ...(params.exclude ?? [])];

    // Find all source files
    let files: string[] = [];
    for (const pattern of patterns) {
        const found = await glob(pattern, {
            cwd: params.path,
            ignore: exclude,
            nodir: true,
            absolute: false,
        });
        files.push(...found);
    }

    // Remove duplicates, normalize to forward slashes, and sort
    files = [...new Set(files)].map(f => f.replace(/\\/g, '/')).sort();

    // Index each file
    let filesIndexed = 0;
    let filesSkipped = 0;
    let totalItems = 0;
    let totalMethods = 0;
    let totalTypes = 0;

    // Use transaction for bulk insert
    db.transaction(() => {
        for (const filePath of files) {
            try {
                const result = indexFile(params.path, filePath, db, queries, incremental, storeBodies);
                if (result.skipped) {
                    filesSkipped++;
                } else if (result.success) {
                    filesIndexed++;
                    totalItems += result.items;
                    totalMethods += result.methods;
                    totalTypes += result.types;
                } else if (result.error) {
                    errors.push(`${filePath}: ${result.error}`);
                }
            } catch (err) {
                errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    });

    // Cleanup unused items
    queries.deleteUnusedItems();

    // --------------------------------------------------------
    // Cleanup: Remove files that are now excluded
    // (e.g., build/ was indexed before exclude pattern was added)
    // --------------------------------------------------------
    let filesRemoved = 0;
    const existingFiles = queries.getAllFiles();

    db.transaction(() => {
        for (const file of existingFiles) {
            // Check if this file path matches any exclude pattern
            const shouldExclude = exclude.some(pattern =>
                minimatch(file.path, pattern, { dot: true })
            );

            if (shouldExclude) {
                // Remove from index
                queries.clearFileData(file.id);
                queries.deleteFile(file.id);
                filesRemoved++;
            }
        }
    });

    if (filesRemoved > 0) {
        // Cleanup items that are now orphaned
        queries.deleteUnusedItems();
    }

    // --------------------------------------------------------
    // Scan project structure (all files, not just code)
    // --------------------------------------------------------
    const indexedFilesSet = new Set(files);  // Code files we indexed

    // Find ALL files in project
    const allFiles = await glob('**/*', {
        cwd: params.path,
        ignore: exclude,
        nodir: true,
        absolute: false,
    });

    // Normalize paths and collect directories
    const directories = new Set<string>();
    const normalizedAllFiles = allFiles.map(f => f.replace(/\\/g, '/'));

    for (const filePath of normalizedAllFiles) {
        // Extract all parent directories
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
            directories.add(parts.slice(0, i).join('/'));
        }
    }

    // Insert directories
    db.transaction(() => {
        for (const dir of directories) {
            queries.insertProjectFile(dir, 'dir', null, false);
        }

        // Insert all files with type detection
        for (const filePath of normalizedAllFiles) {
            const ext = extname(filePath).toLowerCase() || null;
            const fileType = detectFileType(filePath);
            const isIndexed = indexedFilesSet.has(filePath);
            queries.insertProjectFile(filePath, fileType, ext, isIndexed);
        }
    });

    // Reset session tracking after full re-index
    const now = Date.now().toString();
    db.setMetadata('last_session_start', now);
    db.setMetadata('last_session_end', now);
    db.setMetadata('current_session_start', now);

    db.close();

    // Update global registry if it exists
    tryUpdateGlobalRegistry(params.path, {
        files: filesIndexed,
        items: totalItems,
        methods: totalMethods,
        types: totalTypes,
    });

    // Invalidate global query cache so next search sees fresh data
    invalidateGlobalCache();

    // Optional: build/refresh embeddings for this project.
    // Runs entirely in a child process (enable + index) so an ONNX OOM crash
    // cannot kill the MCP server.
    let embeddingsResult: InitResult['embeddings'];
    if (params.embeddings === true) {
        try {
            const r = await indexProjectInWorker(params.path);
            embeddingsResult = {
                embedded: r.embedded,
                skipped: r.skipped,
                removed: r.removed,
                durationMs: r.durationMs,
            };
        } catch (err) {
            errors.push(
                `Embeddings: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    // Optional: persist LLM-layer configuration on the project row.
    if (
        params.llm_endpoint !== undefined ||
        params.llm_model !== undefined ||
        params.llm_send_code !== undefined
    ) {
        try {
            await persistLlmConfig(params.path, params);
        } catch (err) {
            errors.push(
                `LLM config: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    return {
        success: true,
        indexPath: indexDir,
        filesIndexed,
        filesSkipped,
        filesRemoved,
        itemsFound: totalItems,
        methodsFound: totalMethods,
        typesFound: totalTypes,
        durationMs: Date.now() - startTime,
        errors,
        embeddings: embeddingsResult,
    };
}

// ============================================================
// File indexing
// ============================================================

interface IndexFileResult {
    success: boolean;
    skipped?: boolean;
    items: number;
    methods: number;
    types: number;
    error?: string;
}

function indexFile(
    projectPath: string,
    relativePath: string,
    db: AiDexDatabase,
    queries: Queries,
    incremental: boolean = false,
    storeBodies: boolean = false
): IndexFileResult {
    const absolutePath = join(projectPath, relativePath);

    // Read file content
    let content: string;
    try {
        content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
        return {
            success: false,
            items: 0,
            methods: 0,
            types: 0,
            error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Calculate hash
    const hash = shortHash(content);

    // In incremental mode, skip unchanged files
    if (incremental) {
        const existingFile = queries.getFileByPath(relativePath);
        if (existingFile && existingFile.hash === hash) {
            return {
                success: true,
                skipped: true,
                items: 0,
                methods: 0,
                types: 0,
            };
        }
        // File changed - clear old data before re-indexing
        if (existingFile) {
            queries.clearFileData(existingFile.id);
            queries.deleteFile(existingFile.id);
        }
    }

    // Extract data from file
    const extraction = extract(content, relativePath);
    if (!extraction) {
        return {
            success: false,
            items: 0,
            methods: 0,
            types: 0,
            error: 'Unsupported file type or parse error',
        };
    }

    // Insert file record
    const fileId = queries.insertFile(relativePath, hash);

    // Split content into lines for hashing
    const contentLines = content.split('\n');
    const now = Date.now();

    // Insert lines with hash
    let lineId = 1;
    for (const line of extraction.lines) {
        const lineContent = contentLines[line.lineNumber - 1] ?? '';
        const lineHash = shortHash(lineContent);
        queries.insertLine(fileId, lineId++, line.lineNumber, line.lineType, lineHash, now);
    }

    // Build line number to line ID mapping
    const lineNumberToId = new Map<number, number>();
    lineId = 1;
    for (const line of extraction.lines) {
        lineNumberToId.set(line.lineNumber, lineId++);
    }

    // Insert items and occurrences
    const itemsInserted = new Set<string>();
    for (const item of extraction.items) {
        const lineIdForItem = lineNumberToId.get(item.lineNumber);
        if (lineIdForItem === undefined) {
            // Line wasn't recorded, add it now
            const newLineId = lineId++;
            const lineContent = contentLines[item.lineNumber - 1] ?? '';
            const lineHash = shortHash(lineContent);
            queries.insertLine(fileId, newLineId, item.lineNumber, item.lineType, lineHash, now);
            lineNumberToId.set(item.lineNumber, newLineId);
        }

        const itemId = queries.getOrCreateItem(item.term);
        const finalLineId = lineNumberToId.get(item.lineNumber)!;
        queries.insertOccurrence(itemId, fileId, finalLineId);
        itemsInserted.add(item.term);
    }

    // Insert methods (with optional body storage)
    for (const method of extraction.methods) {
        queries.insertMethod(
            fileId,
            method.name,
            method.prototype,
            method.lineNumber,
            method.visibility,
            method.isStatic,
            method.isAsync,
            storeBodies ? method.bodyText : null,
            storeBodies ? method.bodyLines : null,
            storeBodies ? method.bodyTruncated : false
        );
    }

    // Insert types
    for (const type of extraction.types) {
        queries.insertType(fileId, type.name, type.kind, type.lineNumber);
    }

    // Insert signature (header comments)
    if (extraction.headerComments.length > 0) {
        queries.insertSignature(fileId, extraction.headerComments.join('\n'));
    }

    return {
        success: true,
        items: itemsInserted.size,
        methods: extraction.methods.length,
        types: extraction.types.length,
    };
}

// ============================================================
// Global registry integration
// ============================================================

/**
 * Persist llm_endpoint / llm_model / llm_send_code on the project row in global.db.
 * Ensures the embedding-layer schema migration ran first so the columns exist.
 */
async function persistLlmConfig(
    projectPath: string,
    params: InitParams
): Promise<void> {
    const { ensureEmbeddingsSchema } = await import('../embeddings/store.js');
    ensureEmbeddingsSchema();

    const { openGlobalDatabase, globalDbExists } = await import('../db/global-database.js');
    if (!globalDbExists()) return;

    const gdb = openGlobalDatabase();
    try {
        const db = gdb.getDb();
        // Make sure the project is registered first (might be a fresh init).
        const exists = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath);
        if (!exists) return; // tryUpdateGlobalRegistry handles registration; nothing to update yet

        const sets: string[] = [];
        const vals: unknown[] = [];
        if (params.llm_endpoint !== undefined) {
            sets.push('llm_endpoint = ?');
            vals.push(params.llm_endpoint || null);
        }
        if (params.llm_model !== undefined) {
            sets.push('llm_model = ?');
            vals.push(params.llm_model || null);
        }
        if (params.llm_send_code !== undefined) {
            sets.push('llm_send_code = ?');
            vals.push(params.llm_send_code ? 1 : 0);
        }
        if (sets.length === 0) return;
        vals.push(projectPath);
        db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE path = ?`).run(...vals);
    } finally {
        gdb.close();
    }
}

/**
 * Update global registry after init/update. Fire-and-forget — errors are silently ignored.
 */
function tryUpdateGlobalRegistry(projectPath: string, counts: { files: number; items: number; methods: number; types: number }): void {
    try {
        if (!globalDbExists()) return;

        const stats = readProjectStats(projectPath);
        if (!stats) return;

        const globalDb = openGlobalDatabase();
        globalDb.registerProject(projectPath, basename(projectPath), stats);
        globalDb.close();
    } catch {
        // Silently ignore — global registry is optional
    }
}
