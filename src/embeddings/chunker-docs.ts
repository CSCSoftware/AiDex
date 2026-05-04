/**
 * Markdown chunker — splits Markdown documents at heading boundaries.
 *
 * Strategy:
 *  - Split at #/##/### headings (top-level becomes the section anchor).
 *  - Sections larger than MAX_CHARS are further split into overlapping
 *    chunks so big README sections stay searchable without dilution.
 *  - Code fences (```...```) are kept intact — never split mid-fence.
 *  - The document title (first H1, if any) is prepended to each chunk
 *    as context — readers retrieve "Auth: token rotation" not just
 *    "token rotation".
 */

import { createHash } from 'crypto';

export interface MarkdownSection {
    heading: string;     // e.g. "## Architecture" — empty for preamble
    level: number;       // 0 for preamble before any heading, 1..6 for #..######
    body: string;        // section body without the heading line
    startLine: number;   // 1-based line number of the heading (or 1 for preamble)
}

export interface DocChunkInput {
    docTitle: string | null;    // first H1 of the document (used as context)
    section: MarkdownSection;
    /** Index within a section that's been split — 0 if not split. */
    partIndex?: number;
    partCount?: number;
}

export interface ChunkOutput {
    text: string;
    contentHash: string;
}

const MAX_CHARS = 2000;        // ~500 tokens
const OVERLAP_CHARS = 200;     // overlap between adjacent split parts
const FENCE_RE = /^```/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// ============================================================
// Splitting
// ============================================================

/**
 * Split a Markdown document into sections at heading boundaries.
 * Heading lines inside code fences are ignored.
 */
export function splitMarkdown(source: string): MarkdownSection[] {
    const lines = source.split(/\r?\n/);
    const sections: MarkdownSection[] = [];

    let inFence = false;
    let current: MarkdownSection = { heading: '', level: 0, body: '', startLine: 1 };
    let bodyLines: string[] = [];

    const flush = () => {
        current.body = bodyLines.join('\n').trim();
        if (current.body.length > 0 || current.heading.length > 0) {
            sections.push(current);
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (FENCE_RE.test(raw.trim())) {
            inFence = !inFence;
            bodyLines.push(raw);
            continue;
        }
        if (!inFence) {
            const m = raw.match(HEADING_RE);
            if (m) {
                flush();
                bodyLines = [];
                current = {
                    heading: raw.trim(),
                    level: m[1].length,
                    body: '',
                    startLine: i + 1,
                };
                continue;
            }
        }
        bodyLines.push(raw);
    }
    flush();

    return sections;
}

/** Extract the document's first H1 title, or null if none. */
export function findDocTitle(sections: MarkdownSection[]): string | null {
    for (const s of sections) {
        if (s.level === 1) {
            return s.heading.replace(/^#\s+/, '').trim();
        }
    }
    return null;
}

// ============================================================
// Sub-chunking large sections
// ============================================================

/**
 * Split a long section into overlapping windows, never breaking inside code fences.
 */
export function splitLargeSection(body: string, maxChars = MAX_CHARS, overlap = OVERLAP_CHARS): string[] {
    if (body.length <= maxChars) return [body];

    const lines = body.split('\n');
    const fenceMask = computeFenceMask(lines);
    const parts: string[] = [];
    let start = 0;
    let buf: string[] = [];
    let bufChars = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLen = line.length + 1;
        // Don't break while inside a fence — keep accumulating until it closes.
        const wouldOverflow = bufChars + lineLen > maxChars && !fenceMask[i] && bufChars > 0;
        if (wouldOverflow) {
            parts.push(buf.join('\n'));
            // Start next part with overlap from end of current.
            const overlapLines: string[] = [];
            let overlapChars = 0;
            for (let j = buf.length - 1; j >= 0 && overlapChars < overlap; j--) {
                overlapLines.unshift(buf[j]);
                overlapChars += buf[j].length + 1;
            }
            buf = overlapLines;
            bufChars = overlapChars;
            start = i;
        }
        buf.push(line);
        bufChars += lineLen;
    }
    if (buf.length > 0) parts.push(buf.join('\n'));
    return parts;
}

/** Returns a parallel array: true if line[i] is inside a code fence. */
function computeFenceMask(lines: string[]): boolean[] {
    const mask: boolean[] = new Array(lines.length).fill(false);
    let inside = false;
    for (let i = 0; i < lines.length; i++) {
        if (FENCE_RE.test(lines[i].trim())) {
            inside = !inside;
            mask[i] = true; // the fence line itself counts as inside
            continue;
        }
        mask[i] = inside;
    }
    return mask;
}

// ============================================================
// Final chunk text + hash
// ============================================================

export function buildDocChunk(input: DocChunkInput): ChunkOutput {
    const lines: string[] = [];
    if (input.docTitle) lines.push(input.docTitle);
    if (input.section.heading) lines.push(input.section.heading);
    if (input.section.body) lines.push(input.section.body);
    if (input.partCount && input.partCount > 1) {
        lines.push(`(part ${(input.partIndex ?? 0) + 1}/${input.partCount})`);
    }
    const text = lines.join('\n').trim();
    const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 32);
    return { text, contentHash };
}

// ============================================================
// One-shot helper for callers
// ============================================================

export interface DocChunk {
    /** Heading + part suffix, e.g. "## Architecture" or "## Architecture (part 2/3)" */
    anchor: string;
    /** First non-empty line of the chunk (for display). */
    snippetSource: string;
    text: string;
    contentHash: string;
    line: number;
}

/**
 * Chunk an entire Markdown source into ready-to-embed pieces.
 * The preamble (text before any heading) gets a synthetic anchor "preamble".
 */
export function chunkMarkdown(source: string): DocChunk[] {
    const sections = splitMarkdown(source);
    const docTitle = findDocTitle(sections);
    const out: DocChunk[] = [];

    for (const section of sections) {
        const parts = splitLargeSection(section.body);
        const partCount = parts.length;
        for (let i = 0; i < parts.length; i++) {
            const sectionForChunk: MarkdownSection = { ...section, body: parts[i] };
            const chunk = buildDocChunk({
                docTitle,
                section: sectionForChunk,
                partIndex: i,
                partCount,
            });
            // Anchors must be unique within a single doc — repeated headings
            // (e.g. two "#### Whitespace" sections in the same file) would
            // otherwise collide on the (source_path, source_anchor) key and
            // ping-pong on every re-index. Qualifying with the heading's
            // start line guarantees uniqueness without changing semantics.
            const baseAnchor = section.heading || 'preamble';
            const lineSuffix = `@L${section.startLine}`;
            const anchor =
                partCount > 1
                    ? `${baseAnchor}${lineSuffix} (part ${i + 1}/${partCount})`
                    : `${baseAnchor}${lineSuffix}`;
            out.push({
                anchor,
                snippetSource: parts[i].trim().split('\n').slice(0, 2).join(' ').slice(0, 200),
                text: chunk.text,
                contentHash: chunk.contentHash,
                line: section.startLine,
            });
        }
    }
    return out;
}
