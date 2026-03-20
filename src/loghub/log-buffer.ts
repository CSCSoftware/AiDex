/**
 * Log Hub Ring Buffer
 *
 * Fixed-size circular buffer for log entries.
 * Oldest entries are overwritten when full (FIFO).
 * Query iterates newest-first with optional filters.
 */

import type { LogEntry, LogLevel, LogStats } from './log-types.js';

export class LogBuffer {
    private buffer: (LogEntry | null)[];
    private head = 0;          // Next write position
    private count = 0;         // Current number of entries
    private nextId = 1;        // Monotone sequence number
    private sourcesSeen = new Set<string>();
    private levelCounts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };

    constructor(private readonly size: number) {
        this.buffer = new Array(size).fill(null);
    }

    /**
     * Add a log entry to the buffer
     */
    push(level: LogLevel, source: string, message: string, data?: string, timestamp?: number): LogEntry {
        const entry: LogEntry = {
            id: this.nextId++,
            timestamp: timestamp ?? Date.now(),
            level,
            source,
            message,
            data,
            received_at: Date.now(),
        };

        this.buffer[this.head] = entry;
        this.head = (this.head + 1) % this.size;
        if (this.count < this.size) this.count++;

        this.sourcesSeen.add(source);
        this.levelCounts[level]++;

        return entry;
    }

    /**
     * Query entries newest-first with optional filters
     */
    query(opts?: {
        since?: number;
        level?: LogLevel;
        source?: string;
        contains?: string;
        limit?: number;
        consume?: boolean;
    }): LogEntry[] {
        const limit = opts?.limit ?? 50;
        const results: LogEntry[] = [];
        const matchedIndices: number[] = [];

        // Iterate backwards from most recent
        for (let i = 0; i < this.count && results.length < limit; i++) {
            const idx = ((this.head - 1 - i) % this.size + this.size) % this.size;
            const entry = this.buffer[idx];
            if (!entry) continue;

            // Apply filters
            if (opts?.since && entry.timestamp < opts.since) continue;
            if (opts?.level && entry.level !== opts.level) continue;
            if (opts?.source && entry.source !== opts.source) continue;
            if (opts?.contains && !entry.message.toLowerCase().includes(opts.contains.toLowerCase())) continue;

            results.push(entry);
            if (opts?.consume) matchedIndices.push(idx);
        }

        // Remove consumed entries from buffer
        if (opts?.consume && matchedIndices.length > 0) {
            for (const idx of matchedIndices) {
                this.buffer[idx] = null;
            }
            this.count -= matchedIndices.length;
            if (this.count < 0) this.count = 0;
        }

        return results;
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.buffer.fill(null);
        this.head = 0;
        this.count = 0;
        // Keep nextId monotone — don't reset
        this.sourcesSeen.clear();
        this.levelCounts = { debug: 0, info: 0, warn: 0, error: 0 };
    }

    /**
     * Get buffer statistics
     */
    getStats(): Omit<LogStats, 'port' | 'persist'> {
        const usage = this.size > 0 ? Math.round((this.count / this.size) * 100) : 0;

        let oldestId = 0;
        let newestId = 0;
        if (this.count > 0) {
            const newestIdx = ((this.head - 1) % this.size + this.size) % this.size;
            const oldestIdx = this.count < this.size ? 0 : this.head;
            newestId = this.buffer[newestIdx]?.id ?? 0;
            oldestId = this.buffer[oldestIdx]?.id ?? 0;
        }

        return {
            entries: this.count,
            bufferSize: this.size,
            bufferUsage: `${usage}%`,
            sources: [...this.sourcesSeen],
            levelCounts: { ...this.levelCounts },
            oldestId,
            newestId,
        };
    }
}
