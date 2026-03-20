/**
 * Commands module exports
 */

export { validateIndex, noIndexError, withProjectDb, withDatabase, normalizePath, escapeLikeTerm } from './shared.js';
export { init, type InitParams, type InitResult } from './init.js';
export { query, parseTimeOffset, type QueryParams, type QueryResult, type QueryMatch, type QueryMode } from './query.js';
export { signature, signatures, type SignatureParams, type SignatureResult, type SignaturesParams, type SignaturesResult } from './signature.js';
export { update, remove, type UpdateParams, type UpdateResult, type RemoveParams, type RemoveResult } from './update.js';
export { summary, tree, describe, type SummaryParams, type SummaryResult, type TreeParams, type TreeResult, type TreeEntry, type DescribeParams, type DescribeResult } from './summary.js';
export { link, unlink, listLinks, type LinkParams, type LinkResult, type UnlinkParams, type UnlinkResult, type ListLinksParams, type ListLinksResult, type LinkedProject } from './link.js';
export { scan, type ScanParams, type ScanResult, type IndexedProject } from './scan.js';
export { files, type FilesParams, type FilesResult, type ProjectFile } from './files.js';
export { note, getSessionNote, type NoteParams, type NoteResult } from './note.js';
export { session, updateSessionHeartbeat, getSessionInfo, formatSessionTime, formatDuration, type SessionParams, type SessionResult, type SessionInfo, type ChangedFile } from './session.js';
export { task, tasks, type TaskParams, type TaskResult, type TasksParams, type TasksResult, type TaskAction } from './task.js';
export { screenshot, listWindows, type ScreenshotParams, type ScreenshotResult, type ScreenshotMode, type ScreenshotColors, type WindowsParams, type WindowsResult, type WindowInfo } from './screenshot/index.js';
export { globalInit, globalStatus, globalQuery, invalidateGlobalCache, globalSignatures, globalRefresh, globalGuideline, type GlobalInitParams, type GlobalInitResult, type UnindexedRepo, type GlobalStatusParams, type GlobalStatusResult, type GlobalStatusProject, type GlobalQueryParams, type GlobalQueryResult, type GlobalQueryMode, type GlobalSignaturesParams, type GlobalSignaturesResult, type SignatureKind, type GlobalRefreshParams, type GlobalRefreshResult, type GlobalGuidelineParams, type GlobalGuidelineResult, type GuidelineAction } from './global/index.js';
export { log, type LogParams, type LogResult, type LogAction, type LogLevel } from './log.js';
export type { LogEntry, LogStats } from '../loghub/log-types.js';
