/**
 * Screenshot command - Cross-platform screenshot capture
 *
 * Captures screenshots using native OS tools:
 * - Windows: PowerShell + System.Drawing + Win32 API
 * - macOS: screencapture + osascript
 * - Linux: maim/scrot + xdotool
 *
 * No project index required - standalone utility.
 *
 * v1.9.0 - Initial implementation
 */

import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { existsSync, statSync } from 'fs';
import type { ScreenshotParams, ScreenshotResult, PlatformScreenshot, ScreenshotMode } from './types.js';
import { win32Platform } from './platform-win32.js';
import { darwinPlatform } from './platform-darwin.js';
import { linuxPlatform } from './platform-linux.js';
import { postProcess } from './post-process.js';

// ============================================================
// Constants
// ============================================================

const DEFAULT_FILENAME = 'aidex-screenshot.png';
const VALID_MODES: ScreenshotMode[] = ['fullscreen', 'active_window', 'window', 'region', 'rect'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
const MAX_FILENAME_LENGTH = 128;
const MAX_WINDOW_TITLE_LENGTH = 512;
const MAX_DELAY_SECONDS = 60;

// Control characters (C0, DEL, C1) are never legitimate in file names, paths or titles.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
// Filename whitelist: letters, digits, space, '_', '-', '.', '(', ')'. Must not start with '.' or '-'.
const SAFE_FILENAME = /^[\p{L}\p{N}_ ()][\p{L}\p{N}_ ().-]*$/u;

// ============================================================
// Input Validation (security: values reach native tools / scripts)
// ============================================================

/** Parameters arrive from MCP as untyped JSON — enforce real numbers. */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a user-supplied filename: plain basename only, safe characters,
 * allowed image extension. Appends ".png" if no extension was given.
 */
function validateFilename(raw: unknown): { filename?: string; error?: string } {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { error: 'filename must be a non-empty string.' };
    }
    if (raw.length > MAX_FILENAME_LENGTH) {
        return { error: `filename must not exceed ${MAX_FILENAME_LENGTH} characters.` };
    }
    if (CONTROL_CHARS.test(raw)) {
        return { error: 'filename must not contain control characters.' };
    }
    if (raw.includes('/') || raw.includes('\\') || raw.includes(':') || raw.includes('..')) {
        return { error: 'filename must be a plain file name without path separators, ":" or "..". Use save_path for the directory.' };
    }
    if (!SAFE_FILENAME.test(raw)) {
        return { error: 'filename may only contain letters, digits, spaces and _ - . ( ), and must not start with "." or "-".' };
    }

    const dot = raw.lastIndexOf('.');
    const ext = dot > 0 ? raw.slice(dot).toLowerCase() : '';
    if (!ext) {
        return { filename: raw + '.png' };
    }
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return { error: `filename extension must be one of: ${ALLOWED_EXTENSIONS.join(', ')}` };
    }
    return { filename: raw };
}

/**
 * Validate a user-supplied directory: absolute normalized path of an existing directory.
 */
function validateSavePath(raw: unknown): { dir?: string; error?: string } {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { error: 'save_path must be a non-empty string.' };
    }
    if (CONTROL_CHARS.test(raw)) {
        return { error: 'save_path must not contain control characters.' };
    }
    const dir = resolve(raw);
    let isDir = false;
    try {
        isDir = statSync(dir).isDirectory();
    } catch {
        return { error: `save_path does not exist: ${dir}` };
    }
    if (!isDir) {
        return { error: `save_path is not a directory: ${dir}` };
    }
    return { dir };
}

// ============================================================
// Platform Selection
// ============================================================

function getPlatformImpl(): PlatformScreenshot {
    switch (process.platform) {
        case 'win32':
            return win32Platform;
        case 'darwin':
            return darwinPlatform;
        case 'linux':
            return linuxPlatform;
        default:
            throw new Error(`Unsupported platform: ${process.platform}. Supported: Windows, macOS, Linux.`);
    }
}

// ============================================================
// Synchronous Delay
// ============================================================

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ============================================================
// Implementation
// ============================================================

export function screenshot(params: ScreenshotParams): ScreenshotResult {
    // NOTE: MCP arguments are untyped JSON that is only cast to ScreenshotParams.
    // Every value below ends up in native tool arguments or generated scripts,
    // so all of them are checked for their real runtime type here.
    const rawMode: unknown = params.mode ?? 'fullscreen';
    if (typeof rawMode !== 'string' || !VALID_MODES.includes(rawMode as ScreenshotMode)) {
        return {
            success: false,
            file_path: '',
            mode: 'fullscreen',
            error: `mode must be one of: ${VALID_MODES.join(', ')}`,
        };
    }
    const mode = rawMode as ScreenshotMode;
    const fail = (error: string): ScreenshotResult => ({ success: false, file_path: '', mode, error });

    // Validate mode-specific requirements
    let windowTitle = '';
    if (mode === 'window') {
        if (typeof params.window_title !== 'string' || params.window_title.length === 0) {
            return fail('window_title is required when mode is "window". Use aidex_windows to find window titles.');
        }
        if (params.window_title.length > MAX_WINDOW_TITLE_LENGTH) {
            return fail(`window_title must not exceed ${MAX_WINDOW_TITLE_LENGTH} characters.`);
        }
        if (CONTROL_CHARS.test(params.window_title)) {
            return fail('window_title must not contain control characters.');
        }
        windowTitle = params.window_title;
    }

    let rect = { x: 0, y: 0, width: 0, height: 0 };
    if (mode === 'rect') {
        if (params.x === undefined || params.y === undefined || params.width === undefined || params.height === undefined) {
            return fail('x, y, width, and height are all required when mode is "rect".');
        }
        if (!isFiniteNumber(params.x) || !isFiniteNumber(params.y) || !isFiniteNumber(params.width) || !isFiniteNumber(params.height)) {
            return fail('x, y, width, and height must be numbers.');
        }
        rect = {
            x: Math.round(params.x),
            y: Math.round(params.y),
            width: Math.round(params.width),
            height: Math.round(params.height),
        };
        if (rect.width <= 0 || rect.height <= 0) {
            return fail('width and height must be positive.');
        }
    }

    // Validate monitor
    let monitor: number | undefined;
    if (params.monitor !== undefined) {
        if (!isFiniteNumber(params.monitor) || !Number.isInteger(params.monitor) || params.monitor < 0 || params.monitor > 63) {
            return fail('monitor must be a non-negative integer.');
        }
        monitor = params.monitor;
    }

    // Validate delay
    let delay = 0;
    if (params.delay !== undefined) {
        if (!isFiniteNumber(params.delay) || params.delay < 0 || params.delay > MAX_DELAY_SECONDS) {
            return fail(`delay must be a number between 0 and ${MAX_DELAY_SECONDS} seconds.`);
        }
        delay = params.delay;
    }

    // Validate scale
    if (params.scale !== undefined && (!isFiniteNumber(params.scale) || params.scale < 0.1 || params.scale > 1.0)) {
        return fail('scale must be a number between 0.1 and 1.0');
    }

    // Validate colors (includes() is strict: the string "2" does not match)
    const validColors = [2, 4, 16, 256];
    if (params.colors !== undefined && !validColors.includes(params.colors)) {
        return fail(`colors must be one of: ${validColors.join(', ')}`);
    }

    // Resolve file path (filename = plain basename, save_path = existing directory)
    let dir = tmpdir();
    if (params.save_path !== undefined) {
        const checked = validateSavePath(params.save_path);
        if (checked.error) return fail(checked.error);
        dir = checked.dir!;
    }
    let filename = DEFAULT_FILENAME;
    if (params.filename !== undefined) {
        const checked = validateFilename(params.filename);
        if (checked.error) return fail(checked.error);
        filename = checked.filename!;
    }
    const filePath = join(dir, filename);

    // Apply delay
    if (delay > 0) {
        sleepSync(Math.round(delay * 1000));
    }

    try {
        const impl = getPlatformImpl();

        switch (mode) {
            case 'fullscreen':
                impl.captureFullscreen(filePath, monitor);
                break;
            case 'active_window':
                impl.captureActiveWindow(filePath);
                break;
            case 'window':
                impl.captureWindow(filePath, windowTitle);
                break;
            case 'region':
                impl.captureRegion(filePath);
                break;
            case 'rect':
                impl.captureRect(filePath, rect.x, rect.y, rect.width, rect.height);
                break;
        }

        // Verify file was created
        if (!existsSync(filePath)) {
            return {
                success: false,
                file_path: filePath,
                mode,
                error: 'Screenshot file was not created. The capture may have been cancelled or the tool failed silently.',
            };
        }

        // Post-process: scale and/or color reduction
        const needsPostProcess = (params.scale !== undefined && params.scale < 1.0) || params.colors !== undefined;
        let original_size: number | undefined;
        let optimized_size: number | undefined;

        if (needsPostProcess) {
            try {
                const ppResult = postProcess(filePath, {
                    scale: params.scale,
                    colors: params.colors,
                });
                original_size = ppResult.original_size;
                optimized_size = ppResult.optimized_size;
            } catch (ppError) {
                // Post-processing failed — return the unmodified screenshot with a warning
                return {
                    success: true,
                    file_path: filePath,
                    mode,
                    monitor: params.monitor,
                    error: `Screenshot captured but post-processing failed: ${ppError instanceof Error ? ppError.message : String(ppError)}`,
                };
            }
        }

        return {
            success: true,
            file_path: filePath,
            mode,
            monitor: params.monitor,
            scale: params.scale,
            colors: params.colors,
            original_size,
            optimized_size,
        };
    } catch (error) {
        return {
            success: false,
            file_path: filePath,
            mode,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
