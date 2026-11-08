/**
 * macOS platform screenshot implementation
 *
 * Uses native `screencapture` and `osascript` commands.
 * macOS has excellent built-in support for all capture modes.
 *
 * Security: every external tool is started via execFileSync with an argument
 * array (no shell). User-supplied strings (paths, window titles) are never
 * interpolated into a shell command or an AppleScript source; window titles
 * are passed to osascript as a `run` handler argument.
 *
 * v1.9.0
 */

import { execFileSync } from 'child_process';
import { unlinkSync } from 'fs';
import type { PlatformScreenshot, WindowInfo } from './types.js';

// ============================================================
// Helpers
// ============================================================

const PIPE: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];

/** Run screencapture with the given arguments (no shell). */
function screencapture(args: string[], timeout = 10000): void {
    execFileSync('screencapture', args, { timeout, stdio: PIPE });
}

/**
 * Run an AppleScript via osascript (no shell). Extra arguments are passed to
 * the script's `on run argv` handler.
 */
function osascript(script: string, args: string[] = []): string {
    return execFileSync('osascript', ['-e', script, ...args], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: PIPE,
    }).trim();
}

/** A window id returned by osascript must be a plain positive integer. */
function parseWindowId(raw: string): string | null {
    return /^[1-9]\d*$/.test(raw) ? raw : null;
}

// ============================================================
// Platform Implementation
// ============================================================

export const darwinPlatform: PlatformScreenshot = {
    captureFullscreen(filePath: string, monitor?: number): void {
        if (monitor !== undefined) {
            // -D<display> selects monitor (1-based in screencapture)
            screencapture(['-x', `-D${Math.trunc(monitor) + 1}`, filePath]);
        } else {
            screencapture(['-x', filePath]);
        }
    },

    captureActiveWindow(filePath: string): void {
        // Get the window ID of the frontmost window via osascript
        const script = `
tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set frontWin to front window of frontApp
    return id of frontWin
end tell`;
        try {
            const windowId = parseWindowId(osascript(script));
            if (!windowId) throw new Error('No valid window id');
            screencapture(['-x', `-l${windowId}`, filePath]);
        } catch {
            // Fallback: use interactive window capture (space selects window)
            // -w captures window under cursor, -o excludes shadow
            screencapture(['-x', '-o', '-w', filePath], 30000);
        }
    },

    captureWindow(filePath: string, windowTitle: string): void {
        // The title is passed as argv item, never interpolated into the script.
        // It is prefixed with ":" so osascript's option parser can never mistake
        // a title starting with "-" for an option (e.g. "-e ...").
        const script = `
on run argv
    set rawArg to item 1 of argv
    if (length of rawArg) < 2 then return 0
    set searchTitle to text 2 thru -1 of rawArg
    tell application "System Events"
        set matchedId to 0
        repeat with proc in (every application process whose visible is true)
            repeat with w in (every window of proc)
                if name of w contains searchTitle then
                    set matchedId to id of w
                    exit repeat
                end if
            end repeat
            if matchedId > 0 then exit repeat
        end repeat
        return matchedId
    end tell
end run`;

        const windowId = parseWindowId(osascript(script, [':' + windowTitle]));
        if (!windowId) {
            throw new Error(`Window not found: "${windowTitle}". Use aidex_windows to list available windows.`);
        }

        screencapture(['-x', `-l${windowId}`, filePath]);
    },

    captureRect(filePath: string, x: number, y: number, width: number, height: number): void {
        // Capture fullscreen then crop with sips
        const tmpFile = filePath + '.tmp.png';
        try {
            screencapture(['-x', tmpFile]);
            // Crop using sips (built-in macOS tool)
            execFileSync('sips', [
                '-c', String(Math.trunc(height)), String(Math.trunc(width)),
                '--cropOffset', String(Math.trunc(y)), String(Math.trunc(x)),
                tmpFile, '--out', filePath,
            ], { timeout: 10000, stdio: PIPE });
        } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    },

    captureRegion(filePath: string): void {
        // -i enables interactive selection (crosshair cursor)
        // User can press Space to toggle window/selection mode, Escape to cancel
        screencapture(['-i', filePath], 120000);
    },

    listWindows(): WindowInfo[] {
        const script = `
tell application "System Events"
    set output to ""
    repeat with proc in (every application process whose visible is true)
        set pid to unix id of proc
        set pname to name of proc
        try
            repeat with w in (every window of proc)
                set wname to name of w
                set output to output & pid & "|" & pname & "|" & wname & linefeed
            end repeat
        end try
    end repeat
    return output
end tell`;

        const output = osascript(script);

        if (!output) return [];

        return output.split('\n').filter(Boolean).map(line => {
            const [pidStr, processName, ...titleParts] = line.split('|');
            return {
                pid: parseInt(pidStr, 10),
                process_name: processName || '',
                title: titleParts.join('|'),
            };
        });
    },
};
