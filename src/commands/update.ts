/**
 * update command - Update index for a single file
 *
 * Supports:
 * - Full re-index of a file (no line range specified)
 * - Incremental update of a line range (from_line/to_line specified) - future
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { minimatch } from 'minimatch';

import { extract } from '../parser/index.js';
import { DEFAULT_EXCLUDE, readGitignore, shortHash } from './init.js';
import { validateIndex, noIndexError, withDatabase, withProjectDb } from './shared.js';
import { invalidateGlobalCache } from './global/global-query.js';

async function notifyEmbeddingsFileUpdated(projectPath: string, filePath: string): Promise<void> {
    try {
        const { getEmbeddings } = await import('../embeddings/index.js');
        await getEmbeddings().updateFile(projectPath, filePath);
    } catch {
        // Embeddings are best-effort; never break aidex_update.
    }
}

async function notifyEmbeddingsFileRemoved(projectPath: string, filePath: string): Promise<void> {
    try {
        const { getEmbeddings } = await import('../embeddings/index.js');
        await getEmbeddings().removeFile(projectPath, filePath);
    } catch {
        // Embeddings are best-effort; never break aidex_remove.
    }
}

// ============================================================
// Types
// ============================================================

export interface UpdateParams {
    path: string;           // Project path
    file: string;           // Relative file path
    fromLine?: number;      // Optional: Start of change (for future incremental update)
    toLine?: number;        // Optional: End of change (for future incremental update)
}

export interface UpdateResult {
    success: boolean;
    file: string;
    itemsAdded: number;
    itemsRemoved: number;
    methodsUpdated: number;
    typesUpdated: number;
    durationMs: number;
    error?: string;
}

// ============================================================
// Main update function
// ============================================================

export function update(params: UpdateParams): UpdateResult {
    const startTime = Date.now();
    const { path: projectPath } = params;
    // Normalize path to forward slashes (consistent with how paths are stored)
    const relativePath = params.file.replace(/\\/g, '/');

    // Validate project path
    const dbPath = validateIndex(projectPath);
    if (!dbPath) {
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: noIndexError(projectPath),
        };
    }

    // Check if file exists
    const absolutePath = join(projectPath, relativePath);
    if (!existsSync(absolutePath)) {
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: `File does not exist: ${relativePath}`,
        };
    }

    // Check if file is excluded (build/, node_modules/, .gitignore patterns, etc.)
    const gitignorePatterns = readGitignore(projectPath);
    const excludePatterns = [...DEFAULT_EXCLUDE, ...gitignorePatterns];
    const isExcluded = excludePatterns.some(pattern =>
        minimatch(relativePath, pattern, { dot: true })
    );
    if (isExcluded) {
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: `File is excluded by pattern: ${relativePath}`,
        };
    }

    return withDatabase(dbPath, false, (db, queries) => {
        try {
            const storeBodies = db.getMetadata('store_bodies') === '1';

            // Check if file is already indexed
            const existingFile = queries.getFileByPath(relativePath);

            // Read file content
            let content: string;
            try {
                content = readFileSync(absolutePath, 'utf-8');
            } catch (err) {
                return {
                    success: false,
                    file: relativePath,
                    itemsAdded: 0,
                    itemsRemoved: 0,
                    methodsUpdated: 0,
                    typesUpdated: 0,
                    durationMs: Date.now() - startTime,
                    error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
                };
            }

            // Calculate new hash
            const newHash = shortHash(content);

            // Check if file has actually changed
            if (existingFile && existingFile.hash === newHash) {
                return {
                    success: true,
                    file: relativePath,
                    itemsAdded: 0,
                    itemsRemoved: 0,
                    methodsUpdated: 0,
                    typesUpdated: 0,
                    durationMs: Date.now() - startTime,
                    error: 'File unchanged (hash match)',
                };
            }

            // Extract data from file
            const extraction = extract(content, relativePath);
            if (!extraction) {
                return {
                    success: false,
                    file: relativePath,
                    itemsAdded: 0,
                    itemsRemoved: 0,
                    methodsUpdated: 0,
                    typesUpdated: 0,
                    durationMs: Date.now() - startTime,
                    error: 'Unsupported file type or parse error',
                };
            }

            // Count old items for comparison
            let oldItemCount = 0;
            let oldMethodCount = 0;
            let oldTypeCount = 0;

            if (existingFile) {
                const oldOccurrences = queries.getOccurrencesByFile(existingFile.id);
                oldItemCount = new Set(oldOccurrences.map(o => o.item_id)).size;
                oldMethodCount = queries.getMethodsByFile(existingFile.id).length;
                oldTypeCount = queries.getTypesByFile(existingFile.id).length;
            }

            // Split content into lines for hashing
            const contentLines = content.split('\n');
            const now = Date.now();

            // Build map of old line hashes to modified timestamps (for diff tracking)
            // Key is the hash, not line_number - so moved lines keep their timestamp
            const oldHashToModified = new Map<string, number>();
            if (existingFile) {
                const oldLines = queries.getLinesByFile(existingFile.id);
                for (const line of oldLines) {
                    if (line.line_hash && line.modified) {
                        // If same hash appears multiple times, keep the oldest timestamp
                        const existing = oldHashToModified.get(line.line_hash);
                        if (!existing || line.modified < existing) {
                            oldHashToModified.set(line.line_hash, line.modified);
                        }
                    }
                }
            }

            // Perform update in transaction
            let fileId: number;
            let newItemCount = 0;

            db.transaction(() => {
                if (existingFile) {
                    // Clear existing data for this file
                    queries.clearFileData(existingFile.id);

                    // Update hash
                    queries.updateFileHash(existingFile.id, newHash);
                    fileId = existingFile.id;
                } else {
                    // Insert new file record
                    fileId = queries.insertFile(relativePath, newHash);
                }

                // Insert lines with diff tracking
                let lineId = 1;
                for (const line of extraction.lines) {
                    const lineContent = contentLines[line.lineNumber - 1] ?? '';
                    const lineHash = shortHash(lineContent);

                    // Check if this hash existed before (regardless of line number)
                    const oldModified = oldHashToModified.get(lineHash);
                    const modified = oldModified ?? now;  // Keep old timestamp if hash existed

                    queries.insertLine(fileId, lineId++, line.lineNumber, line.lineType, lineHash, modified);
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
                    let itemLineId = lineNumberToId.get(item.lineNumber);
                    if (itemLineId === undefined) {
                        // Line wasn't recorded, add it now
                        const newLineId = lineId++;
                        const lineContent = contentLines[item.lineNumber - 1] ?? '';
                        const lineHash = shortHash(lineContent);

                        const oldModified = oldHashToModified.get(lineHash);
                        const modified = oldModified ?? now;

                        queries.insertLine(fileId, newLineId, item.lineNumber, item.lineType, lineHash, modified);
                        lineNumberToId.set(item.lineNumber, newLineId);
                        itemLineId = newLineId;
                    }

                    const itemId = queries.getOrCreateItem(item.term);
                    queries.insertOccurrence(itemId, fileId, itemLineId);
                    itemsInserted.add(item.term);
                }
                newItemCount = itemsInserted.size;

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
            });

            // Cleanup unused items
            queries.deleteUnusedItems();

            // Invalidate global query cache so next search sees fresh data
            invalidateGlobalCache();

            // Fire-and-forget: refresh embeddings for this file (no-op if not enabled).
            void notifyEmbeddingsFileUpdated(params.path, relativePath);

            return {
                success: true,
                file: relativePath,
                itemsAdded: Math.max(0, newItemCount - oldItemCount),
                itemsRemoved: Math.max(0, oldItemCount - newItemCount),
                methodsUpdated: extraction.methods.length,
                typesUpdated: extraction.types.length,
                durationMs: Date.now() - startTime,
            };
        } catch (err) {
            return {
                success: false,
                file: relativePath,
                itemsAdded: 0,
                itemsRemoved: 0,
                methodsUpdated: 0,
                typesUpdated: 0,
                durationMs: Date.now() - startTime,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    });
}

// ============================================================
// Remove file from index
// ============================================================

export interface RemoveParams {
    path: string;           // Project path
    file: string;           // Relative file path
}

export interface RemoveResult {
    success: boolean;
    file: string;
    removed: boolean;
    error?: string;
}

export function remove(params: RemoveParams): RemoveResult {
    const { path: projectPath } = params;
    // Normalize path to forward slashes
    const relativePath = params.file.replace(/\\/g, '/');

    return withProjectDb(
        projectPath, false,
        (error) => ({ success: false, file: relativePath, removed: false, error }),
        (db, queries) => {
            try {
                const existingFile = queries.getFileByPath(relativePath);

                if (!existingFile) {
                    return {
                        success: true,
                        file: relativePath,
                        removed: false,
                        error: 'File not found in index',
                    };
                }

                // Delete file (CASCADE will handle related data)
                db.transaction(() => {
                    queries.deleteFile(existingFile.id);
                    queries.deleteUnusedItems();
                });

                // Fire-and-forget: drop embeddings for this file (no-op if not enabled).
                void notifyEmbeddingsFileRemoved(projectPath, relativePath);

                return {
                    success: true,
                    file: relativePath,
                    removed: true,
                };
            } catch (err) {
                return {
                    success: false,
                    file: relativePath,
                    removed: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
    );
}
