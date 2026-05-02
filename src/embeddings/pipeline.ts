/**
 * Real embeddings pipeline.
 *
 * indexProject(): reads methods/types from a project's local index.db,
 * chunks them via the three-tier chunker, embeds in batches, and writes to
 * the global embeddings table — skipping items whose content hash matches.
 */

import { join } from 'path';

import { chunkCode } from './chunker.js';
import { chunkMarkdown } from './chunker-docs.js';
import { chunkNote, chunkTask, chunkTaskLog } from './chunker-workspace.js';
import { createEmbedder, type Embedder } from './embedder.js';
import { DEFAULT_MODEL_ID, getModel } from './model-registry.js';
import { runSearch } from './search.js';
import {
    bulkUpsertEmbeddings,
    bumpFilesChanged,
    countProjectEmbeddings,
    deleteEmbeddingByAnchor,
    deleteEmbeddingsByAnchorPrefix,
    deleteEmbeddingsByFile,
    ensureEmbeddingsSchema,
    ensureVecTable,
    getEnabledProjectIds,
    getEnabledProjectsWithModel,
    getFilesChangedSince,
    getLastFullEmbedAt,
    getProjectInfo,
    isProjectEnabled,
    listDocFiles,
    markProjectEnabled,
    openProjectIndexDb,
    pruneDocSectionsExcept,
    pruneEmbeddingsByType,
    pruneFileEmbeddingsExcept,
    readAllTaskLogs,
    readAllTasks,
    readDocFile,
    readExistingHashes,
    readMethodIdentifiers,
    readMethods,
    readMethodsForFile,
    readNoteHistory,
    readSessionNote,
    readTaskById,
    readTaskLogsByTask,
    readTypeIdentifiers,
    readTypes,
    readTypesForFile,
    resetFilesChanged,
    setLastFullEmbedAt,
    totalEmbeddings,
    wipeProjectEmbeddings,
    type EmbeddingWrite,
    type IndexDbHandle,
    type ProjectEmbeddingInfo,
} from './store.js';
import type {
    EmbeddingsModule,
    EnableOptions,
    IndexOptions,
    IndexResult,
    MigrateOptions,
    MigrationResult,
    SearchHit,
    SearchOptions,
    EmbeddingStatus,
} from './index.js';

const NOT_YET = (what: string) =>
    new Error(`${what} is not implemented yet. Coming in a later phase.`);

const BATCH_SIZE = 32;

class RealEmbeddings implements EmbeddingsModule {
    private schemaReady = false;
    private embedder: Embedder | null = null;
    private embedderModelId: string | null = null;

    private ensureSchema(): void {
        if (!this.schemaReady) {
            ensureEmbeddingsSchema();
            this.schemaReady = true;
        }
    }

    private async getEmbedder(modelId: string): Promise<Embedder> {
        if (this.embedder && this.embedderModelId === modelId) return this.embedder;
        if (this.embedder) {
            await this.embedder.dispose();
            this.embedder = null;
        }
        const model = getModel(modelId);
        this.embedder = await createEmbedder(model);
        this.embedderModelId = modelId;
        return this.embedder;
    }

    isEnabled(projectPath: string): boolean {
        try {
            this.ensureSchema();
            return isProjectEnabled(projectPath);
        } catch {
            return false;
        }
    }

    async enable(projectPath: string, opts?: EnableOptions): Promise<void> {
        this.ensureSchema();
        const modelId = opts?.model ?? DEFAULT_MODEL_ID;
        const model = getModel(modelId);
        markProjectEnabled(projectPath, model);
        await ensureVecTable(model.dim);
    }

    async indexProject(projectPath: string, opts: IndexOptions = {}): Promise<IndexResult> {
        this.ensureSchema();
        const t0 = Date.now();

        const project = getProjectInfo(projectPath);
        if (!project) {
            throw new Error(
                `Project not enabled: ${projectPath}. Call enable() first ` +
                    `(or pass embeddings:true / aidex_global_init).`
            );
        }

        const handle = openProjectIndexDb(projectPath);
        if (!handle) {
            throw new Error(
                `No index.db at ${projectPath}/.aidex. Run aidex_init first.`
            );
        }

        try {
            const kinds = new Set(opts.sourceKinds ?? ['code', 'workspace', 'docs']);
            const writes: EmbeddingWrite[] = [];

            if (kinds.has('code')) {
                this.collectCodeWrites(handle, project, writes);
            }
            if (kinds.has('workspace')) {
                this.collectWorkspaceWrites(handle, project, writes);
            }
            if (kinds.has('docs')) {
                this.collectDocsWrites(handle, project, writes);
            }

            // Pre-check: if every write's hash already matches what's in the DB
            // and we're not forcing, skip the (expensive) embedder load entirely.
            // This makes a no-op re-index of an unchanged project nearly instant
            // instead of paying ~30s for model warmup.
            const force = opts.force ?? false;
            const result = await this.embedAndUpsertLazy(project, writes, force);

            // Prune items that disappeared (deleted tasks, removed sections, deleted .md files).
            let pruned = 0;
            if (kinds.has('workspace')) {
                pruned += await this.pruneWorkspaceItems(handle, project, writes);
            }
            if (kinds.has('docs')) {
                pruned += await this.pruneDocItems(project, writes);
            }

            setLastFullEmbedAt(project.id, Date.now());
            resetFilesChanged(project.id);
            return {
                embedded: result.embedded,
                skipped: result.skipped,
                removed: pruned,
                durationMs: Date.now() - t0,
            };
        } finally {
            handle.close();
        }
    }

    private collectDocsWrites(
        handle: IndexDbHandle,
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[]
    ): void {
        const files = listDocFiles(handle, project.path);
        for (const f of files) {
            const source = readDocFile(f.absPath);
            if (source === null) continue;
            const chunks = chunkMarkdown(source);
            for (const c of chunks) {
                writes.push({
                    sourceType: 'doc-section',
                    sourceKind: 'docs',
                    sourcePath: f.path,
                    sourceAnchor: c.anchor,
                    sourceName: c.snippetSource || c.anchor,
                    sourceLine: c.line,
                    sourceText: c.text,
                    contentHash: c.contentHash,
                    isPrivate: false,
                    embedding: new Float32Array(0),
                });
            }
        }
    }

    private async pruneDocItems(
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[]
    ): Promise<number> {
        const keep = new Set<string>();
        for (const w of writes) {
            if (w.sourceKind !== 'docs' || !w.sourceAnchor || !w.sourcePath) continue;
            // Anchors aren't unique by themselves across files — qualify by path.
            // pruneEmbeddingsByType compares anchors only, so we'd over-prune.
            // Instead: collect a set of (path, anchor) combos and prune the rest manually.
            keep.add(`${w.sourcePath}::${w.sourceAnchor}`);
        }
        return pruneDocSectionsExcept(project, keep);
    }

    private collectWorkspaceWrites(
        handle: IndexDbHandle,
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[]
    ): void {
        // Tasks
        const tasks = readAllTasks(handle);
        for (const t of tasks) {
            const chunk = chunkTask(t);
            writes.push({
                sourceType: 'task',
                sourceKind: 'workspace',
                sourcePath: null,
                sourceAnchor: `task:#${t.id}`,
                sourceName: t.title,
                sourceLine: null,
                sourceText: chunk.text,
                contentHash: chunk.contentHash,
                isPrivate: false,
                embedding: new Float32Array(0),
            });
        }

        // Task logs (immutable, but indexProject embeds them all)
        const logs = readAllTaskLogs(handle);
        for (const l of logs) {
            const chunk = chunkTaskLog({
                taskId: l.task_id,
                taskTitle: l.task_title,
                note: l.note,
            });
            writes.push({
                sourceType: 'task-log',
                sourceKind: 'workspace',
                sourcePath: null,
                sourceAnchor: `task:#${l.task_id}:log:${l.id}`,
                sourceName: l.task_title,
                sourceLine: null,
                sourceText: chunk.text,
                contentHash: chunk.contentHash,
                isPrivate: false,
                embedding: new Float32Array(0),
            });
        }

        // Active session note (if any)
        const note = readSessionNote(handle);
        if (note && note.trim()) {
            const chunk = chunkNote({ note });
            writes.push({
                sourceType: 'note',
                sourceKind: 'workspace',
                sourcePath: null,
                sourceAnchor: 'note:current',
                sourceName: 'Session note',
                sourceLine: null,
                sourceText: chunk.text,
                contentHash: chunk.contentHash,
                isPrivate: false,
                embedding: new Float32Array(0),
            });
        }

        // Note history (archived notes)
        const history = readNoteHistory(handle);
        for (const h of history) {
            const chunk = chunkNote({
                note: h.note,
                summary: h.summary,
                archived: true,
                archiveTimestamp: h.created_at,
            });
            writes.push({
                sourceType: 'note-history',
                sourceKind: 'workspace',
                sourcePath: null,
                sourceAnchor: `note:archive:${h.id}`,
                sourceName: h.summary ?? 'Archived note',
                sourceLine: null,
                sourceText: chunk.text,
                contentHash: chunk.contentHash,
                isPrivate: false,
                embedding: new Float32Array(0),
            });
        }
    }

    private async pruneWorkspaceItems(
        handle: IndexDbHandle,
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[]
    ): Promise<number> {
        const groupBy = new Map<string, Set<string>>();
        for (const w of writes) {
            if (w.sourceKind !== 'workspace' || !w.sourceAnchor) continue;
            if (!groupBy.has(w.sourceType)) groupBy.set(w.sourceType, new Set());
            groupBy.get(w.sourceType)!.add(w.sourceAnchor);
        }
        let total = 0;
        for (const [sourceType, keep] of groupBy) {
            total += await pruneEmbeddingsByType(project, sourceType, keep);
        }
        // Also handle source_types with no current writes (e.g. last task-log gone).
        for (const sourceType of ['task', 'task-log', 'note', 'note-history']) {
            if (!groupBy.has(sourceType)) {
                total += await pruneEmbeddingsByType(project, sourceType, new Set());
            }
        }
        return total;
    }

    private collectCodeWrites(
        handle: ReturnType<typeof openProjectIndexDb> & {},
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[]
    ): void {
        // Methods
        const methods = readMethods(handle!);
        for (const m of methods) {
            const startLine = m.lineNumber;
            const endLine = m.lineNumber + (m.bodyLines ?? 1) - 1;
            const identifiers = readMethodIdentifiers(handle!, m.filePath, startLine, endLine);
            const chunk = chunkCode({
                name: m.name,
                signature: m.prototype,
                docComment: m.docComment,
                bodyText: m.bodyText,
                identifiers,
            });
            writes.push({
                sourceType: 'method',
                sourceKind: 'code',
                sourcePath: m.filePath,
                sourceAnchor: `method:${m.name}@${m.lineNumber}`,
                sourceName: m.name,
                sourceLine: m.lineNumber,
                sourceText: chunk.displayText,
                embeddingText: chunk.embeddingText,
                contentHash: chunk.contentHash,
                isPrivate: false,
                embedding: new Float32Array(0), // filled later
            });
        }

        // Types
        const types = readTypes(handle!);
        for (const t of types) {
            const identifiers = readTypeIdentifiers(handle!, t.filePath, t.lineNumber);
            const chunk = chunkCode({
                name: t.name,
                signature: `${t.kind} ${t.name}`,
                identifiers,
            });
            writes.push({
                sourceType: 'type',
                sourceKind: 'code',
                sourcePath: t.filePath,
                sourceAnchor: `type:${t.name}@${t.lineNumber}`,
                sourceName: t.name,
                sourceLine: t.lineNumber,
                sourceText: chunk.displayText,
                embeddingText: chunk.embeddingText,
                contentHash: chunk.contentHash,
                isPrivate: false,
                embedding: new Float32Array(0),
            });
        }
    }

    private async embedAndUpsert(
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[],
        embedder: Embedder,
        force: boolean
    ): Promise<{ embedded: number; skipped: number; removed: number }> {
        // Hash-skip: if content_hash matches what's in DB, we won't re-embed.
        const existingHashes = readExistingHashes(project.id);

        const toEmbed: EmbeddingWrite[] = [];
        const skipShortcut: EmbeddingWrite[] = [];
        for (const w of writes) {
            const key = `${w.sourceType}:${w.sourcePath ?? ''}:${w.sourceAnchor ?? ''}`;
            const prev = existingHashes.get(key);
            if (!force && prev === w.contentHash) {
                skipShortcut.push(w);
            } else {
                toEmbed.push(w);
            }
        }

        // Run model on all-new + changed in batches.
        // Code chunks set `embeddingText` separately so we can give the model the
        // weighted-repetition form while storing a clean display snippet in DB.
        for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
            const batch = toEmbed.slice(i, i + BATCH_SIZE);
            const inputs = batch.map(b => b.embeddingText ?? b.sourceText);
            const vectors = await embedder.embed(inputs);
            for (let j = 0; j < batch.length; j++) {
                batch[j].embedding = vectors[j];
            }
        }

        const upsert = await bulkUpsertEmbeddings(project, toEmbed);
        return {
            embedded: upsert.inserted,
            skipped: upsert.skipped + skipShortcut.length,
            removed: 0,
        };
    }

    /**
     * Like embedAndUpsert, but defers loading the embedder model until we're
     * sure at least one item actually needs to be re-embedded. A re-index of
     * an unchanged project goes from "load 100MB model + warmup ~30s" to a
     * single hash-comparison pass.
     */
    private async embedAndUpsertLazy(
        project: ProjectEmbeddingInfo,
        writes: EmbeddingWrite[],
        force: boolean
    ): Promise<{ embedded: number; skipped: number; removed: number }> {
        const existingHashes = readExistingHashes(project.id);
        const toEmbed: EmbeddingWrite[] = [];
        let shortcutCount = 0;
        for (const w of writes) {
            const key = `${w.sourceType}:${w.sourcePath ?? ''}:${w.sourceAnchor ?? ''}`;
            const prev = existingHashes.get(key);
            if (!force && prev === w.contentHash) {
                shortcutCount++;
            } else {
                toEmbed.push(w);
            }
        }
        if (toEmbed.length === 0) {
            return { embedded: 0, skipped: shortcutCount, removed: 0 };
        }

        const embedder = await this.getEmbedder(project.modelId);
        for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
            const batch = toEmbed.slice(i, i + BATCH_SIZE);
            const inputs = batch.map(b => b.embeddingText ?? b.sourceText);
            const vectors = await embedder.embed(inputs);
            for (let j = 0; j < batch.length; j++) {
                batch[j].embedding = vectors[j];
            }
        }

        const upsert = await bulkUpsertEmbeddings(project, toEmbed);
        return {
            embedded: upsert.inserted,
            skipped: upsert.skipped + shortcutCount,
            removed: 0,
        };
    }

    async updateFile(projectPath: string, filePath: string): Promise<void> {
        this.ensureSchema();
        const project = getProjectInfo(projectPath);
        if (!project) return; // Embeddings not enabled — no-op.

        const handle = openProjectIndexDb(projectPath);
        if (!handle) return;

        try {
            // Build candidate writes from the freshly indexed file.
            const writes: EmbeddingWrite[] = [];

            // Methods + types in this file
            for (const m of readMethodsForFile(handle, filePath)) {
                const startLine = m.lineNumber;
                const endLine = m.lineNumber + (m.bodyLines ?? 1) - 1;
                const identifiers = readMethodIdentifiers(handle, m.filePath, startLine, endLine);
                const chunk = chunkCode({
                    name: m.name,
                    signature: m.prototype,
                    docComment: m.docComment,
                    bodyText: m.bodyText,
                    identifiers,
                });
                writes.push({
                    sourceType: 'method',
                    sourceKind: 'code',
                    sourcePath: m.filePath,
                    sourceAnchor: `method:${m.name}@${m.lineNumber}`,
                    sourceName: m.name,
                    sourceLine: m.lineNumber,
                    sourceText: chunk.displayText,
                    embeddingText: chunk.embeddingText,
                    contentHash: chunk.contentHash,
                    isPrivate: false,
                    embedding: new Float32Array(0),
                });
            }
            for (const t of readTypesForFile(handle, filePath)) {
                const identifiers = readTypeIdentifiers(handle, t.filePath, t.lineNumber);
                const chunk = chunkCode({
                    name: t.name,
                    signature: `${t.kind} ${t.name}`,
                    identifiers,
                });
                writes.push({
                    sourceType: 'type',
                    sourceKind: 'code',
                    sourcePath: t.filePath,
                    sourceAnchor: `type:${t.name}@${t.lineNumber}`,
                    sourceName: t.name,
                    sourceLine: t.lineNumber,
                    sourceText: chunk.displayText,
                    embeddingText: chunk.embeddingText,
                    contentHash: chunk.contentHash,
                    isPrivate: false,
                    embedding: new Float32Array(0),
                });
            }

            // If the file is a Markdown doc, re-chunk it.
            if (/\.(md|mdx|markdown)$/i.test(filePath)) {
                const absPath = join(project.path, filePath);
                const source = readDocFile(absPath);
                if (source !== null) {
                    const chunks = chunkMarkdown(source);
                    for (const c of chunks) {
                        writes.push({
                            sourceType: 'doc-section',
                            sourceKind: 'docs',
                            sourcePath: filePath,
                            sourceAnchor: c.anchor,
                            sourceName: c.snippetSource || c.anchor,
                            sourceLine: c.line,
                            sourceText: c.text,
                            contentHash: c.contentHash,
                            isPrivate: false,
                            embedding: new Float32Array(0),
                        });
                    }
                }
            }

            // Embed + upsert (hash-skip handles unchanged items).
            let touched = 0;
            if (writes.length > 0) {
                const embedder = await this.getEmbedder(project.modelId);
                const r = await this.embedAndUpsert(project, writes, embedder, false);
                touched = r.embedded;
            }

            // Prune anchors that disappeared from this file (renamed/deleted methods, sections).
            const keepAnchors = new Set<string>();
            for (const w of writes) if (w.sourceAnchor) keepAnchors.add(w.sourceAnchor);
            const pruned = await pruneFileEmbeddingsExcept(project, filePath, keepAnchors);

            // Only bump the change counter if we actually made a difference —
            // pure no-op updates (file content didn't change) shouldn't drift the index.
            if (touched > 0 || pruned > 0) {
                bumpFilesChanged(project.id);
            }
        } finally {
            handle.close();
        }
    }

    async removeFile(projectPath: string, filePath: string): Promise<void> {
        this.ensureSchema();
        const project = getProjectInfo(projectPath);
        if (!project) return;
        await deleteEmbeddingsByFile(project, filePath);
        bumpFilesChanged(project.id);
    }

    async onTaskChanged(projectPath: string, taskId: number): Promise<void> {
        this.ensureSchema();
        const project = getProjectInfo(projectPath);
        if (!project) return; // Not enabled — silent no-op.

        const handle = openProjectIndexDb(projectPath);
        if (!handle) return;

        try {
            const task = readTaskById(handle, taskId);
            const writes: EmbeddingWrite[] = [];

            if (task) {
                // Re-embed the task itself.
                const chunk = chunkTask(task);
                writes.push({
                    sourceType: 'task',
                    sourceKind: 'workspace',
                    sourcePath: null,
                    sourceAnchor: `task:#${task.id}`,
                    sourceName: task.title,
                    sourceLine: null,
                    sourceText: chunk.text,
                    contentHash: chunk.contentHash,
                    isPrivate: false,
                    embedding: new Float32Array(0),
                });

                // Re-embed any new logs for this task.
                const logs = readTaskLogsByTask(handle, taskId);
                for (const l of logs) {
                    const c = chunkTaskLog({
                        taskId: l.task_id,
                        taskTitle: l.task_title,
                        note: l.note,
                    });
                    writes.push({
                        sourceType: 'task-log',
                        sourceKind: 'workspace',
                        sourcePath: null,
                        sourceAnchor: `task:#${l.task_id}:log:${l.id}`,
                        sourceName: l.task_title,
                        sourceLine: null,
                        sourceText: c.text,
                        contentHash: c.contentHash,
                        isPrivate: false,
                        embedding: new Float32Array(0),
                    });
                }

                if (writes.length > 0) {
                    const embedder = await this.getEmbedder(project.modelId);
                    await this.embedAndUpsert(project, writes, embedder, false);
                }
            } else {
                // Task was deleted — remove its embedding and ONLY this task's logs.
                // Anchors look like `task:#<id>:log:<logId>`, so we can safely
                // delete by prefix without touching other tasks' log embeddings.
                await deleteEmbeddingByAnchor(project, 'task', `task:#${taskId}`);
                await deleteEmbeddingsByAnchorPrefix(
                    project,
                    `task:#${taskId}:log:`,
                    'task-log'
                );
            }
        } finally {
            handle.close();
        }
    }

    async onNoteChanged(projectPath: string, _noteId?: string): Promise<void> {
        this.ensureSchema();
        const project = getProjectInfo(projectPath);
        if (!project) return;

        const handle = openProjectIndexDb(projectPath);
        if (!handle) return;

        try {
            const note = readSessionNote(handle);
            const writes: EmbeddingWrite[] = [];

            if (note && note.trim()) {
                const chunk = chunkNote({ note });
                writes.push({
                    sourceType: 'note',
                    sourceKind: 'workspace',
                    sourcePath: null,
                    sourceAnchor: 'note:current',
                    sourceName: 'Session note',
                    sourceLine: null,
                    sourceText: chunk.text,
                    contentHash: chunk.contentHash,
                    isPrivate: false,
                    embedding: new Float32Array(0),
                });
            } else {
                await deleteEmbeddingByAnchor(project, 'note', 'note:current');
            }

            // Also catch any new archive entries that appeared (since note write
            // archives the previous active note).
            const history = readNoteHistory(handle);
            for (const h of history) {
                const chunk = chunkNote({
                    note: h.note,
                    summary: h.summary,
                    archived: true,
                    archiveTimestamp: h.created_at,
                });
                writes.push({
                    sourceType: 'note-history',
                    sourceKind: 'workspace',
                    sourcePath: null,
                    sourceAnchor: `note:archive:${h.id}`,
                    sourceName: h.summary ?? 'Archived note',
                    sourceLine: null,
                    sourceText: chunk.text,
                    contentHash: chunk.contentHash,
                    isPrivate: false,
                    embedding: new Float32Array(0),
                });
            }

            if (writes.length > 0) {
                const embedder = await this.getEmbedder(project.modelId);
                await this.embedAndUpsert(project, writes, embedder, false);
            }
        } finally {
            handle.close();
        }
    }

    async search(opts: SearchOptions): Promise<SearchHit[]> {
        this.ensureSchema();
        // Lazy-init vec table for the active model's dimension.
        // We don't know the dim without a project; ensureVecTable in runSearch
        // is implicit because vec0 select queries auto-load via the singleton.
        // But vec0 needs to have been created at least once — done at enable().
        return runSearch(opts);
    }

    async status(projectPath?: string): Promise<EmbeddingStatus> {
        this.ensureSchema();
        if (projectPath) {
            const p = getProjectInfo(projectPath);
            return {
                moduleLoaded: true,
                modelId: p?.modelId ?? null,
                enabledProjects: 1,
                totalEmbeddings: p ? countProjectEmbeddings(p.id) : 0,
                storageBytes: 0,
            };
        }
        const enabled = getEnabledProjectIds();
        return {
            moduleLoaded: true,
            modelId: this.embedderModelId,
            enabledProjects: enabled.length,
            totalEmbeddings: totalEmbeddings(),
            storageBytes: 0,
        };
    }

    async migrate(opts: MigrateOptions): Promise<MigrationResult> {
        this.ensureSchema();
        const target = getModel(opts.toModel);

        const affected = getEnabledProjectsWithModel(opts.fromModel);

        if (!opts.apply) {
            let total = 0;
            for (const p of affected) total += countProjectEmbeddings(p.id);
            return { applied: false, projectsAffected: affected.length, embeddingsAffected: total };
        }

        let totalRows = 0;
        for (const p of affected) {
            totalRows += await wipeProjectEmbeddings(p);
            markProjectEnabled(p.path, target);
            await ensureVecTable(target.dim);
            await this.indexProject(p.path);
        }

        return { applied: true, projectsAffected: affected.length, embeddingsAffected: totalRows };
    }
}

export function createRealModule(): EmbeddingsModule {
    return new RealEmbeddings();
}
