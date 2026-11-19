/**
 * Database module exports
 */

export { AiDexDatabase, openDatabase, createDatabase } from './database.js';
export { Queries, createQueries } from './queries.js';
export type {
    FileRow,
    LineRow,
    ItemRow,
    OccurrenceRow,
    SignatureRow,
    MethodRow,
    TypeRow,
    DependencyRow,
    TaskRow,
    TaskLogRow,
} from './queries.js';
export { diffStructure, netStructureChanges, recordFileReindex, recordFileDeleted, getChangeLogSince, ensureChangeLog, hasChangeLog, CHANGE_LOG_RETENTION_MS } from './change-log.js';
export type { StructureSnapshot, StructureChange, ChangeLogRow, ChangeKind, ChangeItemKind } from './change-log.js';
export { GlobalDatabase, openGlobalDatabase, globalDbExists, getGlobalDbPath, getGlobalDir, readProjectStats } from './global-database.js';
export type { GlobalProject, ProjectStats } from './global-database.js';
