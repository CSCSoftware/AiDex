/**
 * health command — read-only check of the instructions an AI gets loaded
 *
 * Looks at global guidelines, the global CLAUDE.md and (with a project path) the project's
 * guidelines and instruction files. Deterministic, no LLM, never changes anything.
 *
 * Checks: size, dead paths, dated entries, duplicates, project-specific content in global
 * text, untouched entries. Findings are hints: whether a rule is still needed is the user's call.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { openGlobalDatabase } from '../db/global-database.js';
import { getGlobalAlwaysKeys } from './global/global-guideline.js';
import { projectGuideline, loadAlwaysGuidelines, ALWAYS_BUDGET } from './guidelines.js';
import { withProjectDb } from './shared.js';

// ============================================================
// Types
// ============================================================

export interface HealthSource {
    id: string;
    label: string;
    /** Loaded into every session of its scope (always-guideline or instruction file) */
    loaded: boolean;
    /** Applies to all projects */
    global: boolean;
    text: string;
    updatedAt?: number;
}

export interface HealthFinding {
    severity: 'warn' | 'info';
    check: 'size' | 'dead-path' | 'dated' | 'duplicate' | 'scope' | 'untouched';
    source: string;
    message: string;
}

export interface HealthOptions {
    now: number;
    projectNames: string[];
    pathExists: (p: string) => boolean;
    driveExists: (drive: string) => boolean;
}

export interface HealthResult {
    success: boolean;
    sources: Array<{ label: string; chars: number; loaded: boolean }>;
    alwaysChars: number;
    instructionChars: number;
    findings: HealthFinding[];
    error?: string;
}

const BIG_SOURCE = 4000;
const BIG_NOTE = 8000;
const DAY = 24 * 60 * 60 * 1000;
const DATED_AFTER_DAYS = 90;
const UNTOUCHED_AFTER_DAYS = 365;
const MIN_LINE = 40;
const MAX_LINES = 2000;
const MAX_DUPLICATES = 20;
const NEAR_DUPLICATE = 0.8;
const TIME_WORDS = /\b(ab|bis|until|from|stand|status|aktuell|currently|vorerst|tempor[aä]r|vor[uü]bergehend|abo|monat|month)\b/i;

// ============================================================
// Analysis (pure, testable)
// ============================================================

export function analyzeSources(sources: HealthSource[], opts: HealthOptions): HealthFinding[] {
    const findings: HealthFinding[] = [];
    for (const s of sources) {
        checkSize(s, findings);
        checkDeadPaths(s, opts, findings);
        checkDated(s, opts.now, findings);
        checkUntouched(s, opts.now, findings);
        if (s.global && s.loaded) checkScope(s, opts.projectNames, findings);
    }
    checkDuplicates(sources, findings);
    return findings;
}

function checkSize(s: HealthSource, out: HealthFinding[]): void {
    if (s.loaded && s.text.length > BIG_SOURCE) {
        out.push({ severity: 'warn', check: 'size', source: s.label, message: `${s.text.length} characters, loaded into every session (over ${BIG_SOURCE}). Split off what is only needed sometimes.` });
    }
}

function checkDeadPaths(s: HealthSource, opts: HealthOptions, out: HealthFinding[]): void {
    const seen = new Set<string>();
    // (?<![A-Za-z]) and (?![\\/]) keep "http://host" from reading as drive "p:".
    for (const m of s.text.matchAll(/(?<![A-Za-z])[A-Za-z]:[\\/](?![\\/])[^\s`"'<>|*?()]+/g)) {
        let p = m[0].replace(/[.,;:!]+$/, '');
        if (/[%${}]|\.\.\./.test(p)) continue;
        p = p.replace(/[\\/]+$/, '');
        if (p.length < 4 || seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        // A drive that is not there (network drive offline, other OS) says nothing about the path.
        if (!opts.driveExists(p.slice(0, 2))) continue;
        if (!opts.pathExists(p)) {
            out.push({ severity: 'warn', check: 'dead-path', source: s.label, message: `path does not exist: ${p}` });
        }
    }
}

function parseDates(line: string): number[] {
    const times: number[] = [];
    for (const m of line.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)) times.push(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) times.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return times.filter(t => !Number.isNaN(t));
}

function checkDated(s: HealthSource, now: number, out: HealthFinding[]): void {
    for (const raw of s.text.split('\n')) {
        if (!TIME_WORDS.test(raw) || /^\W*(created|updated)\b/i.test(raw)) continue;
        const dates = parseDates(raw);
        if (dates.length === 0) continue;
        const newest = Math.max(...dates);
        const age = Math.floor((now - newest) / DAY);
        if (age > DATED_AFTER_DAYS) {
            out.push({ severity: 'info', check: 'dated', source: s.label, message: `dated line, ${age} days old: ${clip(raw)}` });
        }
    }
}

function checkUntouched(s: HealthSource, now: number, out: HealthFinding[]): void {
    if (s.updatedAt === undefined) return;
    const age = Math.floor((now - s.updatedAt) / DAY);
    if (age > UNTOUCHED_AFTER_DAYS) {
        out.push({ severity: 'info', check: 'untouched', source: s.label, message: `not changed for ${Math.round(age / 30)} months` });
    }
}

function checkScope(s: HealthSource, projectNames: string[], out: HealthFinding[]): void {
    const seen = new Set<string>();
    for (const name of projectNames) {
        if (name.length < 6 || seen.has(name)) continue;
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`).test(s.text)) {
            seen.add(name);
            out.push({ severity: 'info', check: 'scope', source: s.label, message: `applies to all projects but mentions "${name}" — does it belong in that project's guidelines?` });
        }
    }
}

function normalizeLine(line: string): string {
    return line.toLowerCase().replace(/[`*_#>\-•]/g, ' ').replace(/\s+/g, ' ').trim();
}

function words(norm: string): Set<string> {
    return new Set(norm.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
}

function checkDuplicates(sources: HealthSource[], out: HealthFinding[]): void {
    const lines: Array<{ src: string; raw: string; norm: string; w: Set<string> }> = [];
    for (const s of sources) {
        for (const raw of s.text.split('\n')) {
            const norm = normalizeLine(raw);
            if (norm.length >= MIN_LINE) lines.push({ src: s.label, raw: raw.trim(), norm, w: words(norm) });
            if (lines.length >= MAX_LINES) break;
        }
    }
    let reported = 0;
    const done = new Set<string>();
    for (let i = 0; i < lines.length && reported < MAX_DUPLICATES; i++) {
        for (let j = i + 1; j < lines.length && reported < MAX_DUPLICATES; j++) {
            if (lines[i].src === lines[j].src) continue;
            const exact = lines[i].norm === lines[j].norm;
            if (!exact && jaccard(lines[i].w, lines[j].w) < NEAR_DUPLICATE) continue;
            const key = `${lines[i].src}|${lines[j].src}|${lines[i].norm.slice(0, 30)}`;
            if (done.has(key)) continue;
            done.add(key);
            reported++;
            out.push({
                severity: 'warn', check: 'duplicate', source: lines[i].src,
                message: `${exact ? 'same' : 'near-identical'} line also in ${lines[j].src}: ${clip(lines[i].raw)}`,
            });
        }
    }
}

function clip(s: string): string {
    const t = s.trim();
    return t.length > 90 ? t.slice(0, 89).trimEnd() + '…' : t;
}

// ============================================================
// Command
// ============================================================

const INSTRUCTION_FILES = ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'AGENTS.md', 'CLAUDE.local.md'];

function readText(path: string): string | null {
    try {
        return existsSync(path) ? readFileSync(path, 'utf-8').trim() : null;
    } catch {
        return null;
    }
}

export function health(params: { path?: string }): HealthResult {
    try {
        const sources: HealthSource[] = [];
        const projectNames: string[] = [];

        // Global guidelines
        const gdb = openGlobalDatabase();
        try {
            const always = new Set(getGlobalAlwaysKeys());
            for (const g of gdb.listGuidelines()) {
                sources.push({ id: `g:${g.key}`, label: `global guideline "${g.key}"`, loaded: always.has(g.key), global: true, text: g.value, updatedAt: g.updated_at });
            }
            for (const p of gdb.getProjects()) projectNames.push(p.name);
        } finally {
            gdb.close();
        }

        // Global instruction file
        const globalFile = join(homedir(), '.claude', 'CLAUDE.md');
        const globalText = readText(globalFile);
        if (globalText) sources.push({ id: 'f:global', label: '~/.claude/CLAUDE.md', loaded: true, global: true, text: globalText });

        // Project
        if (params.path) {
            const res = projectGuideline({ path: params.path, action: 'list' });
            if (!res.success) {
                return { success: false, sources: [], alwaysChars: 0, instructionChars: 0, findings: [], error: res.error };
            }
            for (const g of res.guidelines ?? []) {
                sources.push({ id: `p:${g.key}`, label: `project guideline "${g.key}"`, loaded: g.always, global: false, text: g.value });
            }
            for (const g of loadAlwaysGuidelines(params.path).project.filter(p => p.from)) {
                sources.push({ id: `p:${g.from}:${g.key}`, label: `parent project ${g.from} guideline "${g.key}"`, loaded: true, global: false, text: g.value });
            }
            for (const name of INSTRUCTION_FILES) {
                const text = readText(join(params.path, name));
                if (text) sources.push({ id: `f:${name}`, label: name.replace(/\\/g, '/'), loaded: true, global: false, text });
            }
        }

        // The session note is loaded at every session start too
        let noteChars = 0;
        if (params.path) {
            noteChars = withProjectDb(params.path, true, () => 0, (db) => (db.getMetadata('session_note') ?? '').length);
        }

        const findings = analyzeSources(sources, {
            now: Date.now(),
            projectNames,
            pathExists: existsSync,
            driveExists: (d) => existsSync(d + '\\') || existsSync(d + '/'),
        });
        if (noteChars > BIG_NOTE) {
            findings.unshift({ severity: 'warn', check: 'size', source: 'session note', message: `${noteChars} characters, loaded at every session start (over ${BIG_NOTE}). Keep the current state and next step, archive the rest (aidex_note history keeps old notes).` });
        }

        const guidelineAlways = sources.filter(s => s.loaded && (s.id.startsWith('g:') || s.id.startsWith('p:')));
        const files = sources.filter(s => s.id.startsWith('f:'));
        return {
            success: true,
            sources: sources.map(s => ({ label: s.label, chars: s.text.length, loaded: s.loaded })),
            alwaysChars: guidelineAlways.reduce((n, s) => n + s.text.length, 0),
            instructionChars: files.reduce((n, s) => n + s.text.length, 0),
            findings,
        };
    } catch (error) {
        return { success: false, sources: [], alwaysChars: 0, instructionChars: 0, findings: [], error: error instanceof Error ? error.message : String(error) };
    }
}

export function formatHealthReport(r: HealthResult): string {
    const warns = r.findings.filter(f => f.severity === 'warn');
    const infos = r.findings.filter(f => f.severity === 'info');
    let msg = '# Health: guidelines & instructions\n\n';
    msg += `Always-guidelines: ${r.alwaysChars} chars (budget ${ALWAYS_BUDGET}${r.alwaysChars > ALWAYS_BUDGET ? ' — OVER' : ''}) · instruction files: ${r.instructionChars} chars · loaded into every session: ${r.alwaysChars + r.instructionChars} chars\n`;
    msg += `${warns.length} warning(s), ${infos.length} hint(s). Read-only: nothing was changed.\n\n`;
    const loaded = r.sources.filter(s => s.loaded).sort((a, b) => b.chars - a.chars);
    if (loaded.length > 0) {
        msg += '## Loaded into every session\n';
        for (const s of loaded) msg += `- ${s.label}: ${s.chars} chars\n`;
        msg += '\n';
    }
    for (const [title, list] of [['Warnings', warns], ['Hints', infos]] as const) {
        if (list.length === 0) continue;
        msg += `## ${title}\n`;
        for (const f of list) msg += `- [${f.check}] ${f.source}: ${f.message}\n`;
        msg += '\n';
    }
    if (r.findings.length === 0) msg += 'Nothing to report.\n';
    return msg.trimEnd();
}
