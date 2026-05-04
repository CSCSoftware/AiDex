/**
 * Code chunker — turns Methods/Types into embedding-ready text.
 *
 * Strategy:
 *   Tier A: Signature
 *   Tier B: Doc-Comment (if any)
 *   Tier C: Weighted identifier bag (top-100 by frequency, repeated as weight)
 *           plus alphanumeric string literals >5 chars from the body.
 *
 * The weighting embeds the heavy hitters (errorCount used 3x → appears 3x in
 * the text) so the embedding model picks them up as the dominant theme.
 */

import { createHash } from 'crypto';

const MAX_IDENTIFIERS = 100;
const MIN_STRING_LITERAL_LEN = 6; // strictly more than 5
const MAX_STRING_LITERALS = 30;

export interface CodeChunkInput {
    name: string;
    signature: string;
    docComment?: string | null;
    bodyText?: string | null;
    /** Identifiers used in the method/type body, with usage counts. */
    identifiers?: Map<string, number>;
}

export interface ChunkOutput {
    /**
     * Backwards-compatible field: equals `embeddingText`.
     * Callers that don't care about the display/embedding split can keep using this.
     */
    text: string;
    /** Text fed to the embedding model (with weighted identifier repetition). */
    embeddingText: string;
    /** Human-readable text stored in source_text and shown in the viewer. */
    displayText: string;
    /** Hash of the embedding-relevant text — used for skip-on-no-change. */
    contentHash: string;
}

/** Public for testing. */
export function extractStringLiterals(body: string): string[] {
    const out: string[] = [];
    // Match "...", '...', and `...` (no escapes for simplicity — good enough for a bag).
    const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const lit = m[2];
        if (lit.length < MIN_STRING_LITERAL_LEN) continue;
        if (!isAlphanumericish(lit)) continue;
        if (looksLikePathOrUrl(lit)) continue;
        out.push(lit);
        if (out.length >= MAX_STRING_LITERALS * 4) break; // hard cap before dedup
    }
    return dedupKeepingOrder(out).slice(0, MAX_STRING_LITERALS);
}

function isAlphanumericish(s: string): boolean {
    // Allow letters, digits, underscores, hyphens; reject if no letter at all.
    if (!/[A-Za-z]/.test(s)) return false;
    return /^[\w\- ]+$/.test(s);
}

function looksLikePathOrUrl(s: string): boolean {
    return /[/\\]/.test(s) || /^https?:/i.test(s);
}

function dedupKeepingOrder<T>(arr: T[]): T[] {
    const seen = new Set<T>();
    const out: T[] = [];
    for (const x of arr) {
        if (!seen.has(x)) {
            seen.add(x);
            out.push(x);
        }
    }
    return out;
}

/** Public for testing — returns the weighted, repetition-based identifier list (for the model). */
export function buildIdentifierBag(identifiers: Map<string, number>): string[] {
    const tokens: string[] = [];
    for (const [name, count] of topIdentifiers(identifiers)) {
        const repeats = Math.min(count, 5); // cap repetition so one identifier can't dominate
        for (let i = 0; i < repeats; i++) tokens.push(name);
    }
    return tokens;
}

/** Public for testing — returns "name (count), name (count), ..." for display. */
export function buildIdentifierBagDisplay(identifiers: Map<string, number>): string {
    return topIdentifiers(identifiers)
        .map(([name, count]) => `${name} (${count})`)
        .join(', ');
}

function topIdentifiers(identifiers: Map<string, number>): Array<[string, number]> {
    // Sort by frequency desc, name asc — stable, deterministic.
    const entries = Array.from(identifiers.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    return entries.slice(0, MAX_IDENTIFIERS);
}

export function chunkCode(input: CodeChunkInput): ChunkOutput {
    const header: string[] = [];

    // Tier A: Signature
    header.push(input.signature || input.name);

    // Tier B: Doc-Comment
    if (input.docComment && input.docComment.trim()) {
        header.push(input.docComment.trim());
    }

    // Tier C: Identifier bag + string literals
    const idTokensModel = input.identifiers ? buildIdentifierBag(input.identifiers) : [];
    const idDisplay = input.identifiers ? buildIdentifierBagDisplay(input.identifiers) : '';
    const literals = input.bodyText ? extractStringLiterals(input.bodyText) : [];

    const headerText = header.join('\n');

    // Embedding text — what the model sees (weighted via repetition).
    const embedTier3: string[] = [];
    if (idTokensModel.length > 0) embedTier3.push('Identifiers: ' + idTokensModel.join(' '));
    if (literals.length > 0) embedTier3.push('Strings: ' + literals.join(' | '));
    const embeddingText = [headerText, embedTier3.join('\n')].filter(s => s.length > 0).join('\n');

    // Display text — what the user reads in viewer / DB snippet (counts in parentheses).
    const displayTier3: string[] = [];
    if (idDisplay) displayTier3.push('Identifiers: ' + idDisplay);
    if (literals.length > 0) displayTier3.push('Strings: ' + literals.join(' | '));
    const displayText = [headerText, displayTier3.join('\n')].filter(s => s.length > 0).join('\n');

    const contentHash = createHash('sha256').update(embeddingText).digest('hex').slice(0, 32);
    return {
        text: embeddingText,        // backwards-compat alias
        embeddingText,
        displayText,
        contentHash,
    };
}
