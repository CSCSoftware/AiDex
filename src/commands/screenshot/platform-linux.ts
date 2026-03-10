/**
 * Linux platform screenshot implementation
 *
 * Uses maim (preferred) or scrot (fallback) for capture,
 * xdotool for window identification, wmctrl for window listing.
 *
 * v1.9.0
 */

import { execFileSync } from 'child_process';
import type { PlatformScreenshot, WindowInfo } from './types.js';
import { hasTool } from './shared.js';

// ============================================================
// Tool Detection
// ============================================================

function requireTool(primary: string, fallback?: string): string {
    if (hasTool(primary)) return primary;
    if (fallback && hasTool(fallback)) return fallback;
    const installHint = fallback
        ? `Neither "${primary}" nor "${fallback}" found. Install one: sudo apt install ${primary}`
        : `"${primary}" not found. Install it: sudo apt install ${primary}`;
    throw new Error(installHint);
}

// ============================================================
// Platform Implementation
// ============================================================

export const linuxPlatform: PlatformScreenshot = {
    captureFullscreen(filePath: string, monitor?: number): void {
        const tool = requireTool('maim', 'scrot');
        if (tool === 'maim') {
            if (monitor !== undefined) {
                // Get monitor geometry via xrandr
                try {
                    const xrandrOutput = execFileSync('xrandr', ['--query'], {
                        encoding: 'utf8',
                        timeout: 5000,
                        stdio: ['pipe', 'pipe', 'pipe'],
                    });
                    const monitors = xrandrOutput
                        .split('\n')
                        .filter(line => line.includes(' connected'))
                        .map(line => {
                            const match = line.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/);
                            return match ? { w: match[1], h: match[2], x: match[3], y: match[4] } : null;
                        })
                        .filter(Boolean);

                    if (monitor < monitors.length && monitors[monitor]) {
                        const m = monitors[monitor]!;
                        execFileSync('maim', ['-g', `${m.w}x${m.h}+${m.x}+${m.y}`, filePath], {
                            timeout: 10000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        });
                        return;
                    }
                } catch { /* fall through to default capture */ }
            }
            execFileSync('maim', [filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } else {
            execFileSync('scrot', [filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
    },

    captureActiveWindow(filePath: string): void {
        const tool = requireTool('maim', 'scrot');
        if (tool === 'maim') {
            requireTool('xdotool');
            const windowId = execFileSync('xdotool', ['getactivewindow'], {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            execFileSync('maim', ['-i', windowId, filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } else {
            execFileSync('scrot', ['-u', filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
    },

    captureWindow(filePath: string, windowTitle: string): void {
        requireTool('xdotool');
        const tool = requireTool('maim', 'scrot');

        let windowId: string;
        try {
            // Use execFileSync to avoid shell injection — pass title as argument
            windowId = execFileSync('xdotool', ['search', '--name', windowTitle], {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim().split('\n')[0] ?? '';
        } catch {
            throw new Error(`Window not found: "${windowTitle}". Use aidex_windows to list available windows.`);
        }

        if (!windowId) {
            throw new Error(`Window not found: "${windowTitle}". Use aidex_windows to list available windows.`);
        }

        if (tool === 'maim') {
            execFileSync('maim', ['-i', windowId, filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } else {
            // scrot: focus window first, then capture active window
            execFileSync('xdotool', ['windowfocus', windowId], {
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            execFileSync('sleep', ['0.2'], { timeout: 1000 });
            execFileSync('scrot', ['-u', filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
    },

    captureRect(filePath: string, x: number, y: number, width: number, height: number): void {
        const tool = requireTool('maim', 'scrot');
        if (tool === 'maim') {
            // maim -g WxH+X+Y captures a specific geometry
            execFileSync('maim', ['-g', `${width}x${height}+${x}+${y}`, filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } else {
            // scrot doesn't support rect natively, capture full then crop with ImageMagick
            const tmpFile = filePath + '.tmp.png';
            execFileSync('scrot', [tmpFile], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            requireTool('convert'); // ImageMagick
            execFileSync('convert', [tmpFile, '-crop', `${width}x${height}+${x}+${y}`, '+repage', filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            try { execFileSync('rm', [tmpFile], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { /* ignore */ }
        }
    },

    captureRegion(filePath: string): void {
        const tool = requireTool('maim', 'scrot');
        if (tool === 'maim') {
            // maim -s uses slop for interactive selection
            if (!hasTool('slop')) {
                throw new Error('"slop" is required for region selection with maim. Install it: sudo apt install slop');
            }
            execFileSync('maim', ['-s', filePath], {
                timeout: 120000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } else {
            execFileSync('scrot', ['-s', filePath], {
                timeout: 120000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
    },

    listWindows(): WindowInfo[] {
        if (hasTool('wmctrl')) {
            const output = execFileSync('wmctrl', ['-l', '-p'], {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (!output) return [];

            return output.split('\n').filter(Boolean).map(line => {
                const parts = line.split(/\s+/);
                const pid = parseInt(parts[2], 10);
                const title = parts.slice(4).join(' ');
                return { pid: isNaN(pid) ? 0 : pid, process_name: '', title };
            });
        }

        if (hasTool('xdotool')) {
            let ids: string[];
            try {
                ids = execFileSync('xdotool', ['search', '--name', ''], {
                    encoding: 'utf8',
                    timeout: 5000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }).trim().split('\n').filter(Boolean);
            } catch {
                return [];
            }

            return ids.slice(0, 50).map(id => {
                try {
                    const title = execFileSync('xdotool', ['getwindowname', id], {
                        encoding: 'utf8',
                        timeout: 2000,
                        stdio: ['pipe', 'pipe', 'pipe'],
                    }).trim();
                    let pid = 0;
                    try {
                        pid = parseInt(execFileSync('xdotool', ['getwindowpid', id], {
                            encoding: 'utf8',
                            timeout: 2000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        }).trim(), 10);
                    } catch { /* some windows don't have PID */ }
                    return { pid: isNaN(pid) ? 0 : pid, process_name: '', title };
                } catch {
                    return { pid: 0, process_name: '', title: '' };
                }
            }).filter(w => w.title);
        }

        throw new Error('Neither "wmctrl" nor "xdotool" found. Install one: sudo apt install wmctrl');
    },
};
