// Direct test for the MISSING backpressure guard in broadcastTreeUpdate.
//
// Background: v2.1.0 added bufferedAmount guards to broadcastLogEntry and
// broadcastTaskUpdate, but broadcastTreeUpdate (src/viewer/server.ts:194)
// still calls client.send() with no guard. On an actively-changing project
// (e.g. UcHome: logging + builds churn files constantly) chokidar fires often,
// each event rebuilds codeTree + allTree and broadcasts a LARGE payload. A slow
// browser client makes ws's internal send-queue grow without bound -> 50+ GB.
//
// Strategy: same as test-backpressure.mjs, but with a realistic tree-sized
// payload. Compare unguarded (today's code) vs guarded (the proposed fix).

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = 13334;
const WS_BACKPRESSURE_BYTES = 1_048_576;

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function rss() { return process.memoryUsage().rss; }
function heap() { return process.memoryUsage().heapUsed; }

// Build a tree payload roughly the size a mid/large project produces.
// A node = { name, path, type, children, gitStatus, ... }. ~150 bytes/node.
// 1500 nodes per tree, two trees (code + all) -> ~450 KB per refresh frame.
function makeNode(i, depth) {
    const node = {
        name: `file_${i}_${'segment'.repeat(2)}.ts`,
        path: `src/some/nested/path/segment${depth}/file_${i}.ts`,
        type: 'file',
        gitStatus: 'modified',
        lines: 1200 + i,
        size: 40000 + i,
    };
    if (depth < 2) {
        node.type = 'directory';
        node.children = [];
        for (let c = 0; c < 6; c++) node.children.push(makeNode(i * 10 + c, depth + 1));
    }
    return node;
}
function makeTree(rootCount) {
    const roots = [];
    for (let i = 0; i < rootCount; i++) roots.push(makeNode(i, 0));
    return { name: 'root', path: '.', type: 'directory', children: roots };
}

async function run(mode) {
    console.log(`\n=== Mode: ${mode} ===`);
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise(r => httpServer.listen(PORT, '127.0.0.1', r));

    // One silent client (the realistic leak case: a single idle viewer tab).
    const clients = [];
    for (let i = 0; i < 1; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
        await new Promise(r => ws.once('open', r));
        ws._socket.pause(); // queue up server-side
        clients.push(ws);
    }
    await new Promise(r => setTimeout(r, 100));
    console.log(`Connected ${wss.clients.size} client(s)`);

    const codeTree = makeTree(40);
    const allTree = makeTree(40);
    const payload = JSON.stringify({ type: 'refresh', codeTree, allTree });
    console.log(`  payload size: ${fmtMB(Buffer.byteLength(payload))}`);

    const dropCounts = new WeakMap();
    function broadcastWithGuard() {
        wss.clients.forEach((client) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (client.bufferedAmount > WS_BACKPRESSURE_BYTES) {
                dropCounts.set(client, (dropCounts.get(client) ?? 0) + 1);
                return;
            }
            client.send(payload);
        });
    }
    function broadcastNoGuard() {
        wss.clients.forEach((client) => {
            if (client.readyState !== WebSocket.OPEN) return;
            client.send(payload);
        });
    }

    const broadcast = mode === 'guarded' ? broadcastWithGuard : broadcastNoGuard;
    const rssStart = rss();
    const heapStart = heap();

    // Fewer iterations than the log test — each frame is ~1000x bigger.
    const N = 5_000;
    for (let i = 0; i < N; i++) {
        broadcast();
        if (i % 500 === 0) {
            const buf = [...wss.clients].reduce((s, c) => s + c.bufferedAmount, 0);
            console.log(`  i=${i.toString().padStart(6)}  rss=${fmtMB(rss())}  buffered=${fmtMB(buf)}`);
        }
    }

    const rssEnd = rss();
    const totalBuffered = [...wss.clients].reduce((s, c) => s + c.bufferedAmount, 0);
    let totalDropped = 0;
    for (const c of wss.clients) totalDropped += dropCounts.get(c) ?? 0;

    console.log(`  -- ${mode} done --`);
    console.log(`  RSS:      ${fmtMB(rssStart)} -> ${fmtMB(rssEnd)}   delta=${fmtMB(rssEnd - rssStart)}`);
    console.log(`  Buffered: ${fmtMB(totalBuffered)}`);
    console.log(`  Dropped:  ${totalDropped}`);

    for (const c of clients) c.terminate();
    wss.close();
    await new Promise(r => httpServer.close(r));

    return { mode, rssDelta: rssEnd - rssStart, buffered: totalBuffered, dropped: totalDropped };
}

const r1 = await run('unguarded');
if (global.gc) global.gc();
await new Promise(r => setTimeout(r, 500));
const r2 = await run('guarded');

console.log('\n=== Verdict ===');
console.log(`unguarded: rssDelta=${fmtMB(r1.rssDelta)}  buffered=${fmtMB(r1.buffered)}  dropped=${r1.dropped}`);
console.log(`guarded:   rssDelta=${fmtMB(r2.rssDelta)}  buffered=${fmtMB(r2.buffered)}  dropped=${r2.dropped}`);

if (r2.dropped > 0 && r2.buffered <= WS_BACKPRESSURE_BYTES * 4 && r1.buffered > r2.buffered * 10) {
    console.log('\nPASS: tree-update guard prevents unbounded buffering (drops engaged, buffered stays near cap).');
    process.exit(0);
} else {
    console.log('\nFAIL: guard did not behave as expected.');
    process.exit(1);
}
