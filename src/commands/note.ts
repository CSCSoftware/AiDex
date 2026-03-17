/**
 * note command - Session notes for cross-session communication
 *
 * Stores a single text note in the project's AiDex database that persists
 * between sessions. Useful for:
 * - Reminders for the next session ("Test glob pattern fix!")
 * - User requests ("Remember to refactor X")
 * - Auto-generated notes before session end
 *
 * v1.3.0 - Session tracking integration
 * v1.10.0 - Note history: archived notes are searchable
 */

import { openDatabase } from '../db/index.js';
import { validateIndex, noIndexError } from './shared.js';

// ============================================================
// Types
// ============================================================

export interface NoteParams {
    path: string;
    note?: string;      // If provided, sets the note. If omitted, reads current note.
    append?: boolean;   // If true, appends to existing note instead of replacing
    clear?: boolean;    // If true, clears the note
    history?: boolean;  // If true, shows archived note history
    search?: string;    // If provided, searches note history for this term
    limit?: number;     // Max history entries to return (default 20)
    summary?: string;   // One-sentence summary for the archived note (~150 chars)
}

export interface NoteHistoryEntry {
    id: number;
    note: string;
    summary: string | null;
    created_at: number;
}

export interface NoteResult {
    success: boolean;
    note: string | null;
    action: 'read' | 'write' | 'append' | 'clear' | 'history' | 'search';
    history?: NoteHistoryEntry[];
    historyCount?: number;
    error?: string;
}

// ============================================================
// Constants
// ============================================================

const NOTE_KEY = 'session_note';

// ============================================================
// Implementation
// ============================================================

export function note(params: NoteParams): NoteResult {
    const { path: projectPath, note: newNote, append, clear, history, search, limit } = params;

    // Validate project path
    const dbPath = validateIndex(projectPath);
    if (!dbPath) {
        return {
            success: false,
            note: null,
            action: 'read',
            error: noIndexError(projectPath),
        };
    }

    // History and search need write access too (for auto-migration)
    const isWriteOperation = newNote !== undefined || clear;
    const needsReadWrite = isWriteOperation || history || search !== undefined;

    const db = openDatabase(dbPath, !needsReadWrite);

    try {
        // Auto-migrate: ensure note_history table exists (for DBs created before v1.10)
        if (needsReadWrite) {
            db.getDb().exec(`
                CREATE TABLE IF NOT EXISTS note_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note TEXT NOT NULL,
                    summary TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_note_history_created ON note_history(created_at);
            `);
            // Add summary column if missing (for existing DBs before v1.15)
            const hasSummary = db.getDb().prepare(
                "SELECT COUNT(*) as cnt FROM pragma_table_info('note_history') WHERE name = 'summary'"
            ).get() as { cnt: number };
            if (hasSummary.cnt === 0) {
                db.getDb().exec('ALTER TABLE note_history ADD COLUMN summary TEXT');
            }
        }

        // --- Search history ---
        if (search !== undefined) {
            const results = db.searchNoteHistory(search, limit ?? 20);
            const totalCount = db.countNoteHistory();
            return {
                success: true,
                note: null,
                action: 'search',
                history: results,
                historyCount: totalCount,
            };
        }

        // --- Show history ---
        if (history) {
            const results = db.getNoteHistory(limit ?? 20);
            const totalCount = db.countNoteHistory();
            return {
                success: true,
                note: null,
                action: 'history',
                history: results,
                historyCount: totalCount,
            };
        }

        // --- Clear ---
        if (clear) {
            // Archive current note before clearing
            const existing = db.getMetadata(NOTE_KEY);
            if (existing) {
                db.archiveNote(existing, params.summary);
            }
            db.deleteMetadata(NOTE_KEY);
            return {
                success: true,
                note: null,
                action: 'clear',
            };
        }

        // --- Write or append ---
        if (newNote !== undefined) {
            let finalNote = newNote;

            if (append) {
                const existing = db.getMetadata(NOTE_KEY);
                if (existing) {
                    finalNote = existing + '\n' + newNote;
                }
            } else {
                // Overwrite: archive the old note first
                const existing = db.getMetadata(NOTE_KEY);
                if (existing) {
                    db.archiveNote(existing, params.summary);
                }
            }

            db.setMetadata(NOTE_KEY, finalNote);

            return {
                success: true,
                note: finalNote,
                action: append ? 'append' : 'write',
            };
        }

        // --- Read ---
        const currentNote = db.getMetadata(NOTE_KEY);

        return {
            success: true,
            note: currentNote,
            action: 'read',
        };

    } catch (error) {
        return {
            success: false,
            note: null,
            action: 'read',
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        db.close();
    }
}

/**
 * Get note for a project (used internally by other tools to include in output)
 */
export function getSessionNote(projectPath: string): string | null {
    const dbPath = validateIndex(projectPath);
    if (!dbPath) {
        return null;
    }

    try {
        const db = openDatabase(dbPath, true);
        try {
            return db.getMetadata(NOTE_KEY);
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}
