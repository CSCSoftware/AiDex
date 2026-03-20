/**
 * Log Hub Types
 *
 * Shared types for the Log Hub system (HTTP server, ring buffer, MCP tool).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogAction = 'init' | 'free' | 'status' | 'query' | 'clear' | 'write';

export interface LogEntry {
    id: number;
    timestamp: number;      // Client-provided timestamp (ms)
    level: LogLevel;
    source: string;
    message: string;
    data?: string;          // Optional JSON data
    received_at: number;    // Server receive time (ms)
}

export interface LogConfig {
    port: number;
    bufferSize: number;
    persist: boolean;
    path?: string;          // Project path for DB persistence
}

export interface LogParams {
    action: LogAction;
    port?: number;
    buffer_size?: number;
    persist?: boolean;
    path?: string;
    // query filters
    since?: string;         // Time offset like "30m", "2h", or ISO date
    level?: LogLevel;
    source?: string;
    contains?: string;
    limit?: number;
    // write
    message?: string;
    data?: string;
}

export interface LogResult {
    success: boolean;
    action: LogAction;
    entries?: LogEntry[];
    stats?: LogStats;
    error?: string;
}

export interface LogStats {
    entries: number;
    bufferSize: number;
    bufferUsage: string;
    sources: string[];
    levelCounts: Record<LogLevel, number>;
    port: number;
    oldestId: number;
    newestId: number;
    persist: boolean;
}

export interface LogHttpEntry {
    level?: string;
    source?: string;
    message?: string;
    timestamp?: number;
    data?: unknown;
}
