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
 *
 * Security: user-supplied values (paths, window titles, ...) must NOT be
 * interpolated into `script`. Pass them via `env` instead and read them in the
 * script as `$env:NAME` — PowerShell never evaluates the content of a variable,
 * so quotes, `$(...)`, backticks or Unicode quote characters stay inert.
 */
export function runPowerShell(
    script: string,
    timeoutMs = 30000,
    prefix = 'aidex',
    env?: Record<string, string>,
): string {
    const tmpPs1 = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}.ps1`);
    writeFileSync(tmpPs1, script, 'utf8');
    try {
        return execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1],
            {
                encoding: 'utf8',
                timeout: timeoutMs,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: env ? { ...process.env, ...env } : process.env,
            }
        ).trim();
    } finally {
        try { unlinkSync(tmpPs1); } catch { /* ignore */ }
    }
}
