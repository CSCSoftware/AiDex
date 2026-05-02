/**
 * Workspace chunker — turns tasks, notes, and history entries into
 * embedding-ready text. Workspace items are pure prose, so no fancy
 * three-tier chunking — just sensible concatenation with section markers.
 */

import { createHash } from 'crypto';

export interface TaskChunkInput {
    id: number;
    title: string;
    description: string | null;
    summary: string | null;
    tags: string | null;
    status: string;
    priority: number;
}

export interface TaskLogChunkInput {
    taskId: number;
    taskTitle: string;
    note: string;
}

export interface NoteChunkInput {
    note: string;
    summary?: string | null;
    archived?: boolean;
    archiveTimestamp?: number;
}

export interface ChunkOutput {
    text: string;
    contentHash: string;
}

const MAX_TEXT_CHARS = 4000;

function clamp(s: string): string {
    if (s.length <= MAX_TEXT_CHARS) return s;
    return s.slice(0, MAX_TEXT_CHARS - 20) + '\n... [truncated]';
}

function hashOf(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export function chunkTask(input: TaskChunkInput): ChunkOutput {
    const lines: string[] = [];
    lines.push(`Task #${input.id}: ${input.title}`);
    lines.push(`Status: ${input.status} | Priority: ${input.priority}`);
    if (input.tags) lines.push(`Tags: ${input.tags}`);
    if (input.summary) lines.push(`Summary: ${input.summary}`);
    if (input.description) lines.push('Description:\n' + input.description);
    const text = clamp(lines.join('\n'));
    return { text, contentHash: hashOf(text) };
}

export function chunkTaskLog(input: TaskLogChunkInput): ChunkOutput {
    const text = clamp(`Task #${input.taskId} (${input.taskTitle}) — Log:\n${input.note}`);
    return { text, contentHash: hashOf(text) };
}

export function chunkNote(input: NoteChunkInput): ChunkOutput {
    const lines: string[] = [];
    if (input.archived && input.archiveTimestamp) {
        const date = new Date(input.archiveTimestamp).toISOString().slice(0, 10);
        lines.push(`Archived note (${date}):`);
    } else {
        lines.push('Session note:');
    }
    if (input.summary) lines.push(`Summary: ${input.summary}`);
    lines.push(input.note);
    const text = clamp(lines.join('\n'));
    return { text, contentHash: hashOf(text) };
}
