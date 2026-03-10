/**
 * Shared utilities for screenshot platform implementations
 */

import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';

// ============================================================
// Tool Detection
// ============================================================

/**
 * Check if a command-line tool is available on the system.
 * Uses execFileSync to avoid shell injection.
 */
export function hasTool(name: string): boolean {
    try {
        // 'which' on Linux/macOS, 'where' on Windows
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execFileSync(cmd, [name], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
    } catch {
        return false;
    }
}

// ============================================================
// PowerShell Execution (Windows)
// ============================================================

/**
 * Run a PowerShell script by writing it to a temp .ps1 file.
 * Avoids shell quoting issues with inline -Command.
 */
export function runPowerShell(script: string, timeoutMs = 30000, prefix = 'aidex'): string {
    const tmpPs1 = join(tmpdir(), `${prefix}-${Date.now()}.ps1`);
    writeFileSync(tmpPs1, script, 'utf8');
    try {
        return execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1],
            { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
    } finally {
        try { unlinkSync(tmpPs1); } catch { /* ignore */ }
    }
}
