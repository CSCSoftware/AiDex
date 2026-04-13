/**
 * global-init command
 *
 * Scans a directory tree for AiDex-indexed projects and registers them
 * in the global database (~/.aidex/global.db).
 * Also finds unindexed projects (by project markers like .csproj, package.json, etc.)
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { INDEX_DIR } from '../../constants.js';
import { openGlobalDatabase, readProjectStats } from '../../db/global-database.js';
import { scan } from '../scan.js';
import { init } from '../init.js';
import { startProgress, sendProgress, stopProgress } from '../../viewer/progress.js';

// ============================================================
// Types
// ============================================================

export interface GlobalInitParams {
    path: string;
    maxDepth?: number;
    tags?: string;
    exclude?: string[];  // Directory names or paths to skip
    indexUnindexed?: boolean;  // Auto-index all unindexed projects (≤500 files)
    showProgress?: boolean;   // Show progress UI in browser
}

export interface UnindexedProject {
    path: string;
    name: string;
    markers: string[];  // Which project markers were found
    estimatedFiles: number;  // Quick file count estimate
}

export interface IndexedProjectResult {
    name: string;
    path: string;
    success: boolean;
    filesIndexed: number;
    methodsFound: number;
    error?: string;
}

export interface GlobalInitResult {
    success: boolean;
    searchPath: string;
    registered: number;
    newProjects: number;
    updatedProjects: number;
    removedProjects: number;
    unindexedProjects: UnindexedProject[];
    indexedResults?: IndexedProjectResult[];  // Only when indexUnindexed=true
    largeProjects?: UnindexedProject[];       // Projects >500 files, need user decision
    totals: {
        projects: number;
        files: number;
        items: number;
        methods: number;
        types: number;
    };
    error?: string;
}

// Keep old name as alias for backwards compatibility in type exports
export type UnindexedRepo = UnindexedProject;

// ============================================================
// Project marker files
// ============================================================

/** Files that indicate a directory is a project root */
const PROJECT_MARKERS = [
    // .NET / C#
    '*.sln', '*.csproj', '*.fsproj', '*.vbproj',
    // Node.js / TypeScript / JavaScript
    'package.json',
    // Rust
    'Cargo.toml',
    // Go
    'go.mod',
    // Python
    'pyproject.toml', 'setup.py', 'setup.cfg',
    // Java
    'pom.xml', 'build.gradle', 'build.gradle.kts',
    // Ruby
    'Gemfile',
    // PHP
    'composer.json',
    // C/C++
    'CMakeLists.txt', 'Makefile', 'meson.build',
];

/** Glob-style markers that need directory listing (e.g., *.sln) */
const GLOB_MARKERS = PROJECT_MARKERS.filter(m => m.startsWith('*'));
/** Exact-name markers */
const EXACT_MARKERS = PROJECT_MARKERS.filter(m => !m.startsWith('*'));

// ============================================================
// Implementation
// ============================================================

export async function globalInit(params: GlobalInitParams): Promise<GlobalInitResult> {
    const { path: searchPath, maxDepth = 10, tags, exclude = [] } = params;
    const FILE_THRESHOLD = 500;

    if (!existsSync(searchPath)) {
        return {
            success: false,
            searchPath,
            registered: 0,
            newProjects: 0,
            updatedProjects: 0,
            removedProjects: 0,
            unindexedProjects: [],
            totals: { projects: 0, files: 0, items: 0, methods: 0, types: 0 },
            error: `Path does not exist: ${searchPath}`,
        };
    }

    // Use existing scan to find all .aidex/ projects
    const scanResult = scan({ path: searchPath, maxDepth });
    if (!scanResult.success) {
        return {
            success: false,
            searchPath,
            registered: 0,
            newProjects: 0,
            updatedProjects: 0,
            removedProjects: 0,
            unindexedProjects: [],
            totals: { projects: 0, files: 0, items: 0, methods: 0, types: 0 },
            error: scanResult.error,
        };
    }

    // Open global database
    const globalDb = openGlobalDatabase();

    try {
        // --------------------------------------------------------
        // Deduplicate: Remove parent projects that contain sub-projects
        // e.g., AudioGrabber/ contains AudioGrabber/AudioGrabber/ and AudioGrabber/AudioGrabber2/
        // → keep only the sub-projects, skip the parent
        // --------------------------------------------------------
        const deduplicatedProjects = deduplicateProjects(scanResult.projects);

        // Get existing projects for comparison
        const existingProjects = new Map(
            globalDb.getProjects().map(p => [p.path.replace(/\\/g, '/'), p])
        );

        let newCount = 0;
        let updatedCount = 0;

        // Register each found project (deduplicated)
        for (const project of deduplicatedProjects) {
            const normalizedPath = project.path.replace(/\\/g, '/');
            const stats = readProjectStats(project.path);
            if (!stats) continue;

            const isNew = !existingProjects.has(normalizedPath);

            globalDb.registerProject(
                project.path,
                project.name,
                stats,
                tags
            );

            if (isNew) {
                newCount++;
            } else {
                updatedCount++;
            }

            // Remove from existing map (remaining ones are "missing")
            existingProjects.delete(normalizedPath);
        }

        // Remove projects that no longer exist under this search path
        let removedCount = 0;
        const searchPathNorm = searchPath.replace(/\\/g, '/');
        for (const [path] of existingProjects) {
            // Only remove if it was under the scanned path
            if (path.startsWith(searchPathNorm)) {
                if (!existsSync(join(path, INDEX_DIR, 'index.db'))) {
                    globalDb.unregisterProject(path);
                    removedCount++;
                }
            }
        }

        // Remove parent-duplicate projects already in the global DB
        // (from previous runs before deduplication was added)
        // Only remove parents with DIRECT children (one level deeper)
        const allRegistered = globalDb.getProjects();
        const allPaths = allRegistered.map(p => ({
            id: p.id,
            path: p.path.replace(/\\/g, '/').replace(/\/+$/, '') + '/',
            files_count: p.files_count,
        }));
        for (const project of allPaths) {
            // Skip projects that have their own files — they are real projects, not wrappers
            if (project.files_count > 0) continue;
            const hasDirectChild = allPaths.some(other => {
                if (other.id === project.id) return false;
                if (!other.path.startsWith(project.path)) return false;
                const remainder = other.path.slice(project.path.length);
                const segments = remainder.replace(/\/+$/, '').split('/');
                return segments.length === 1;
            });
            if (hasDirectChild) {
                globalDb.unregisterProject(project.path.replace(/\/+$/, ''));
                removedCount++;
            }
        }

        // Collect paths of indexed projects for exclusion (use deduplicated list)
        const indexedPaths = new Set(
            deduplicatedProjects.map(p => p.path.replace(/\\/g, '/'))
        );

        // Find projects without .aidex/ index
        const allUnindexed = findUnindexedProjects(searchPath, maxDepth, indexedPaths, exclude);

        // Split into small and large
        const smallProjects = allUnindexed.filter(p => p.estimatedFiles <= FILE_THRESHOLD);
        const largeProjects = allUnindexed.filter(p => p.estimatedFiles > FILE_THRESHOLD);

        // Bulk-index small projects if requested
        let indexedResults: IndexedProjectResult[] | undefined;
        if (params.indexUnindexed && smallProjects.length > 0) {
            if (params.showProgress) {
                startProgress(`Indexing ${smallProjects.length} projects`);
            }

            indexedResults = [];
            for (let i = 0; i < smallProjects.length; i++) {
                const proj = smallProjects[i];

                if (params.showProgress) {
                    sendProgress({
                        current: i + 1,
                        total: smallProjects.length,
                        name: proj.name,
                        status: 'indexing',
                    });
                }

                try {
                    const r = await init({ path: proj.path });
                    const result: IndexedProjectResult = {
                        name: proj.name,
                        path: proj.path,
                        success: r.success,
                        filesIndexed: r.filesIndexed,
                        methodsFound: r.methodsFound,
                    };
                    if (!r.success && r.errors.length > 0) {
                        result.error = r.errors[0];
                    }
                    indexedResults.push(result);

                    // Register in global DB
                    if (r.success) {
                        const stats = readProjectStats(proj.path);
                        if (stats) {
                            globalDb.registerProject(proj.path, proj.name, stats, tags);
                            newCount++;
                        }
                    }

                    if (params.showProgress) {
                        sendProgress({
                            current: i + 1,
                            total: smallProjects.length,
                            name: proj.name,
                            status: r.success ? 'done' : 'error',
                            detail: r.success
                                ? `${r.filesIndexed} files, ${r.methodsFound} methods`
                                : r.errors[0],
                        });
                    }
                } catch (err) {
                    indexedResults.push({
                        name: proj.name,
                        path: proj.path,
                        success: false,
                        filesIndexed: 0,
                        methodsFound: 0,
                        error: err instanceof Error ? err.message : String(err),
                    });

                    if (params.showProgress) {
                        sendProgress({
                            current: i + 1,
                            total: smallProjects.length,
                            name: proj.name,
                            status: 'error',
                            detail: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }

            const successCount = indexedResults.filter(r => r.success).length;
            const failCount = indexedResults.filter(r => !r.success).length;

            if (params.showProgress) {
                stopProgress(`Indexed ${successCount} projects` + (failCount > 0 ? `, ${failCount} failed` : ''));
            }
        }

        // Get totals (after potential bulk indexing)
        const totals = globalDb.getTotals();

        globalDb.close();

        return {
            success: true,
            searchPath,
            registered: params.indexUnindexed
                ? deduplicatedProjects.length + (indexedResults?.filter(r => r.success).length ?? 0)
                : deduplicatedProjects.length,
            newProjects: newCount,
            updatedProjects: updatedCount,
            removedProjects: removedCount,
            unindexedProjects: params.indexUnindexed ? [] : allUnindexed,
            indexedResults,
            largeProjects: largeProjects.length > 0 ? largeProjects : undefined,
            totals,
        };
    } catch (error) {
        globalDb.close();
        return {
            success: false,
            searchPath,
            registered: 0,
            newProjects: 0,
            updatedProjects: 0,
            removedProjects: 0,
            unindexedProjects: [],
            totals: { projects: 0, files: 0, items: 0, methods: 0, types: 0 },
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// ============================================================
// Helpers
// ============================================================

const DEFAULT_EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
    'dist', 'build', 'out', 'target', 'bin', 'obj',
    '.next', '.nuxt', 'vendor', '.gradle', '.idea', '.vscode',
    'Library', // Unity Library folder (huge, not a project)
    // Python virtual environments & package dirs
    'venv', '.venv', 'env', '.env', 'virtualenv',
    'site-packages', '.eggs', '.tox', '.mypy_cache', '.pytest_cache',
    // Embedded runtimes & external codec libs
    'Python310', 'Python311', 'Python312', 'Python313',
    'fdk-aac',
    // Rust
    '.cargo',
    // .NET
    'packages', // NuGet packages
]);

/**
 * Check if a directory contains any project marker files.
 * Returns the list of found markers, or empty array if none.
 */
function detectProjectMarkers(dirPath: string): string[] {
    const found: string[] = [];

    // Check exact-name markers
    for (const marker of EXACT_MARKERS) {
        if (existsSync(join(dirPath, marker))) {
            found.push(marker);
        }
    }

    // Check glob markers (*.sln, *.csproj, etc.) — need to list directory
    if (GLOB_MARKERS.length > 0) {
        try {
            const entries = readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) continue;
                for (const pattern of GLOB_MARKERS) {
                    const ext = pattern.slice(1); // "*.sln" → ".sln"
                    if (entry.name.endsWith(ext)) {
                        found.push(entry.name);
                        break; // One match per file is enough
                    }
                }
            }
        } catch {
            // Skip unreadable directories
        }
    }

    return found;
}

/**
 * Count code files recursively (matching parser-supported extensions).
 * Only counts files that init() would actually process.
 * Excludes the same dirs as DEFAULT_EXCLUDED_DIRS.
 * Early exit at cap to stay fast.
 */
const CODE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.cs', '.rs', '.py', '.pyw',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
    '.java', '.go', '.php', '.rb', '.rake',
]);

function estimateFileCount(dirPath: string): number {
    const CAP = 1000;
    let count = 0;

    function walk(dir: string): void {
        if (count >= CAP) return;
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (count >= CAP) return;
                if (entry.name.startsWith('.')) continue;
                if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
                if (entry.isFile()) {
                    const dot = entry.name.lastIndexOf('.');
                    if (dot >= 0 && CODE_EXTS.has(entry.name.slice(dot).toLowerCase())) {
                        count++;
                    }
                } else if (entry.isDirectory()) {
                    walk(join(dir, entry.name));
                }
            }
        } catch { /* skip */ }
    }

    walk(dirPath);
    return count;
}

/**
 * Find projects that don't have an .aidex/ index yet.
 * Detects projects by marker files (.csproj, package.json, Cargo.toml, etc.)
 */
function findUnindexedProjects(searchPath: string, maxDepth: number, indexedPaths: Set<string>, userExclude: string[]): UnindexedProject[] {
    const projects: UnindexedProject[] = [];

    // Build exclude set: default dirs + user-specified names/paths
    const excludedDirs = new Set(DEFAULT_EXCLUDED_DIRS);
    const excludedPaths = new Set<string>();
    for (const ex of userExclude) {
        // If it looks like a path (contains / or \), treat as absolute path to exclude
        if (ex.includes('/') || ex.includes('\\')) {
            excludedPaths.add(ex.replace(/\\/g, '/').replace(/\/+$/, ''));
        } else {
            // Otherwise treat as directory name
            excludedDirs.add(ex);
        }
    }

    function walk(dirPath: string, depth: number): void {
        if (depth > maxDepth) return;

        const normalizedPath = dirPath.replace(/\\/g, '/');

        // Skip excluded paths
        if (excludedPaths.has(normalizedPath)) return;

        // Skip if already indexed
        if (indexedPaths.has(normalizedPath)) return;

        // Skip if it has .aidex/ (shouldn't happen since those are in indexedPaths, but safety check)
        if (existsSync(join(dirPath, INDEX_DIR))) return;

        // Check for project markers
        const markers = detectProjectMarkers(dirPath);
        if (markers.length > 0) {
            projects.push({
                path: dirPath,
                name: basename(dirPath),
                markers,
                estimatedFiles: estimateFileCount(dirPath),
            });
            // Don't return — there might be sub-projects (e.g., monorepo with nested .csproj)
        }

        // Recurse into subdirectories
        try {
            const entries = readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith('.')) continue;
                if (excludedDirs.has(entry.name)) continue;
                walk(join(dirPath, entry.name), depth + 1);
            }
        } catch {
            // Skip unreadable directories
        }
    }

    walk(searchPath, 0);
    return projects;
}

/**
 * Deduplicate projects: If project A is a parent directory of project B,
 * keep only B (the more specific sub-project) — but only when B is a
 * DIRECT child of A (one level deeper).
 *
 * Example: Given paths [AudioGrabber/, AudioGrabber/AudioGrabber/, AudioGrabber/AudioGrabber2/]
 * → Remove AudioGrabber/ because it has direct sub-projects.
 * → Keep AudioGrabber/AudioGrabber/ and AudioGrabber/AudioGrabber2/.
 *
 * Counter-example: [Aidex/, Aidex/SampleLangProjects/java-minimal-json/]
 * → Keep Aidex/ because the sub-project is nested 2+ levels deep (not a direct child).
 */
function deduplicateProjects<T extends { path: string; name: string; files?: number }>(projects: T[]): T[] {
    // Normalize all paths
    const normalized = projects.map(p => ({
        ...p,
        _normPath: p.path.replace(/\\/g, '/').replace(/\/+$/, '') + '/',
    }));

    // Sort by path length descending (deepest first)
    normalized.sort((a, b) => b._normPath.length - a._normPath.length);

    // A project is a "parent" only if another project is a DIRECT child (one level deeper)
    // BUT: keep parents that have their own indexed files (they are real projects, not just wrappers)
    const result: typeof projects = [];
    for (const project of normalized) {
        const hasDirectChild = normalized.some(other => {
            if (other === project) return false;
            if (!other._normPath.startsWith(project._normPath)) return false;
            // Check if it's a direct child: the remaining path after the parent
            // should contain no additional slashes (only "childName/")
            const remainder = other._normPath.slice(project._normPath.length);
            const segments = remainder.replace(/\/+$/, '').split('/');
            return segments.length === 1;
        });
        // Keep the project if it has no direct children, OR if it has its own files
        // (a project with files is a real project, not just a wrapper directory)
        if (!hasDirectChild || (project.files != null && project.files > 0)) {
            result.push(project);
        }
    }

    return result;
}
