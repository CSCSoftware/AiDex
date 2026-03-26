/**
 * init command - Initialize AiDex for a project
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename, extname } from 'path';
import { glob } from 'glob';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { INDEX_DIR } from '../constants.js';
import { invalidateGlobalCache } from './global/global-query.js';

/**
 * Compute a short (16-char) SHA256 hash of content.
 * Used consistently across init, update, and session for file/line hashing.
 */
export function shortHash(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

import { createDatabase, createQueries, type AiDexDatabase, type Queries } from '../db/index.js';
import { extract, getSupportedExtensions } from '../parser/index.js';

// ============================================================
// Types
// ============================================================

export interface InitParams {
    path: string;
    name?: string;
    languages?: string[];
    exclude?: string[];
    fresh?: boolean;  // Force fresh re-index (delete all existing data)
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

// ============================================================
// File type detection
// ============================================================

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.cs', '.rs', '.py', '.pyw',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
    '.java', '.go', '.php', '.rb', '.rake'
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
                const result = indexFile(params.path, filePath, db, queries, incremental);
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
    incremental: boolean = false
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

    // Insert methods
    for (const method of extraction.methods) {
        queries.insertMethod(
            fileId,
            method.name,
            method.prototype,
            method.lineNumber,
            method.visibility,
            method.isStatic,
            method.isAsync
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
 * Update global registry after init/update. Fire-and-forget — errors are silently ignored.
 */
function tryUpdateGlobalRegistry(projectPath: string, counts: { files: number; items: number; methods: number; types: number }): void {
    try {
        const { globalDbExists, readProjectStats, openGlobalDatabase } = require('../db/global-database.js');
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
