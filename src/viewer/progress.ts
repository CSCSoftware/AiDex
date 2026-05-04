/**
 * Progress UI - Lightweight SSE-based progress display
 *
 * Opens a browser window showing a progress bar + log.
 * Reusable for any long-running operation (global_init, bulk indexing, etc.)
 *
 * Uses Server-Sent Events (SSE) — simple, one-way, no WebSocket needed.
 */

import express from 'express';
import { createServer, type Server } from 'http';
import { exec } from 'child_process';
import type { Response } from 'express';

const PROGRESS_PORT = 3334;

let progressServer: Server | null = null;
let sseClients: Set<Response> = new Set();

export interface ProgressEvent {
    current: number;
    total: number;
    name: string;
    status: 'indexing' | 'done' | 'skipped' | 'error';
    detail?: string;
}

/**
 * Start the progress server and open browser
 */
export function startProgress(title: string): void {
    if (progressServer) return;  // Already running

    const app = express();

    app.get('/', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.send(getProgressHTML(title));
    });

    app.get('/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        sseClients.add(res);

        req.on('close', () => {
            sseClients.delete(res);
        });
    });

    progressServer = createServer(app);
    progressServer.listen(PROGRESS_PORT, '127.0.0.1', () => {
        const url = `http://localhost:${PROGRESS_PORT}`;
        console.error(`[Progress] Server started at ${url}`);

        // Open browser
        const cmd = process.platform === 'win32' ? `start ${url}`
            : process.platform === 'darwin' ? `open ${url}`
            : `xdg-open ${url}`;
        exec(cmd, () => {});
    });
}

/**
 * Send a progress event to all connected browsers
 */
export function sendProgress(event: ProgressEvent): void {
    const data = JSON.stringify(event);
    for (const client of sseClients) {
        try {
            client.write(`data: ${data}\n\n`);
        } catch {
            sseClients.delete(client);
        }
    }
}

/**
 * Signal completion and close server after a short delay
 */
export function stopProgress(summary?: string): void {
    // Send final event
    const data = JSON.stringify({ type: 'complete', summary: summary ?? 'Done' });
    for (const client of sseClients) {
        try {
            client.write(`data: ${data}\n\n`);
        } catch { /* ignore */ }
    }

    // Close after 1s to let browsers receive the final event
    setTimeout(() => {
        if (progressServer) {
            sseClients.clear();
            progressServer.close();
            progressServer = null;
            console.error('[Progress] Server stopped');
        }
    }, 1000);
}

/**
 * Check if progress server is running
 */
export function isProgressRunning(): boolean {
    return progressServer !== null;
}

// ============================================================
// HTML
// ============================================================

function getProgressHTML(title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AiDex — ${title}</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #1e1e2e; color: #cdd6f4;
        padding: 24px; min-height: 100vh;
    }
    h1 { font-size: 18px; color: #89b4fa; margin-bottom: 16px; }
    .stats {
        display: flex; gap: 24px; margin-bottom: 16px;
        font-size: 14px; color: #a6adc8;
    }
    .stats span { color: #cdd6f4; font-weight: 600; }
    .progress-wrap {
        background: #313244; border-radius: 8px;
        height: 32px; overflow: hidden; margin-bottom: 8px;
        position: relative;
    }
    .progress-bar {
        height: 100%; background: linear-gradient(90deg, #89b4fa, #74c7ec);
        border-radius: 8px; transition: width 0.3s ease;
        width: 0%;
    }
    .progress-text {
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 13px; font-weight: 600; color: #1e1e2e;
        mix-blend-mode: difference;
    }
    .current-item {
        font-size: 13px; color: #a6adc8; margin-bottom: 16px;
        height: 20px; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap;
    }
    .log {
        background: #181825; border-radius: 8px; padding: 12px;
        font-family: 'Cascadia Code', 'Fira Code', monospace;
        font-size: 12px; line-height: 1.6;
        max-height: calc(100vh - 200px); overflow-y: auto;
    }
    .log-entry { display: flex; gap: 8px; }
    .log-entry .num { color: #585b70; min-width: 40px; text-align: right; }
    .log-entry .name { color: #cdd6f4; flex: 1; }
    .log-entry .status-ok { color: #a6e3a1; }
    .log-entry .status-skip { color: #f9e2af; }
    .log-entry .status-err { color: #f38ba8; }
    .log-entry .detail { color: #585b70; }
    .summary {
        margin-top: 16px; padding: 12px; background: #313244;
        border-radius: 8px; font-size: 14px; color: #a6e3a1;
        display: none;
    }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="stats">
    <div>Progress: <span id="count">0/0</span></div>
    <div>Done: <span id="done">0</span></div>
    <div>Skipped: <span id="skipped">0</span></div>
    <div>Errors: <span id="errors">0</span></div>
</div>
<div class="progress-wrap">
    <div class="progress-bar" id="bar"></div>
    <div class="progress-text" id="pct">0%</div>
</div>
<div class="current-item" id="current">&nbsp;</div>
<div class="log" id="log"></div>
<div class="summary" id="summary"></div>

<script>
const log = document.getElementById('log');
const bar = document.getElementById('bar');
const pct = document.getElementById('pct');
const count = document.getElementById('count');
const current = document.getElementById('current');
const done = document.getElementById('done');
const skipped = document.getElementById('skipped');
const errors = document.getElementById('errors');
const summary = document.getElementById('summary');

let doneCount = 0, skipCount = 0, errCount = 0;

const es = new EventSource('/events');
es.onmessage = (e) => {
    const d = JSON.parse(e.data);

    if (d.type === 'complete') {
        current.textContent = 'Complete!';
        summary.textContent = d.summary;
        summary.style.display = 'block';
        es.close();
        return;
    }

    const percent = Math.round((d.current / d.total) * 100);
    bar.style.width = percent + '%';
    pct.textContent = percent + '%';
    count.textContent = d.current + '/' + d.total;
    current.textContent = d.name + ' — ' + d.status + (d.detail ? ' (' + d.detail + ')' : '');

    if (d.status === 'done') doneCount++;
    else if (d.status === 'skipped') skipCount++;
    else if (d.status === 'error') errCount++;

    done.textContent = doneCount;
    skipped.textContent = skipCount;
    errors.textContent = errCount;

    if (d.status !== 'indexing') {
        const statusClass = d.status === 'done' ? 'status-ok'
            : d.status === 'skipped' ? 'status-skip' : 'status-err';
        const detail = d.detail ? '<span class="detail">' + d.detail + '</span>' : '';
        log.innerHTML += '<div class="log-entry">'
            + '<span class="num">' + d.current + '</span>'
            + '<span class="name">' + d.name + '</span>'
            + '<span class="' + statusClass + '">' + d.status + '</span>'
            + detail + '</div>';
        log.scrollTop = log.scrollHeight;
    }
};
</script>
</body>
</html>`;
}
