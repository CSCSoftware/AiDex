// Direct test for the backpressure guard in broadcastLogEntry.
//
// Strategy: start a real WebSocketServer on a free port, connect 3 clients,
// don't let them read. Then call broadcastLogEntry-like sends in a tight loop
// with the same bufferedAmount guard. Compare: WITH guard memory must stay
// bounded, WITHOUT guard it grows.

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = 13333;
const WS_BACKPRESSURE_BYTES = 1_048_576;

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function rss() { return process.memoryUsage().rss; }
function heap() { return process.memoryUsage().heapUsed; }

async function run(mode) {
    console.log(`\n=== Mode: ${mode} ===`);
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise(r => httpServer.listen(PORT, '127.0.0.1', r));

    // Silent clients (don't read)
    const clients = [];
    for (let i = 0; i < 3; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
        await new Promise(r => ws.once('open', r));
        // Pause the underlying socket so messages queue up server-side.
        ws._socket.pause();
        clients.push(ws);
    }
    await new Promise(r => setTimeout(r, 100));
    console.log(`Connected ${wss.clients.size} clients`);

    const dropCounts = new WeakMap();
    const payload = JSON.stringify({
        type: 'log',
        entry: {
            id: 1,
            timestamp: Date.now(),
            level: 'info',
            source: 'loadtest',
            message: 'x'.repeat(500),
            data: undefined,
            received_at: Date.now(),
        },
    });

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

    const N = 200_000;
    for (let i = 0; i < N; i++) {
        broadcast();
        if (i % 20_000 === 0) {
            const buf = [...wss.clients].reduce((s, c) => s + c.bufferedAmount, 0);
            console.log(`  i=${i.toString().padStart(7)}  rss=${fmtMB(rss())}  heap=${fmtMB(heap())}  buffered=${fmtMB(buf)}`);
        }
    }

    const rssEnd = rss();
    const heapEnd = heap();
    const totalBuffered = [...wss.clients].reduce((s, c) => s + c.bufferedAmount, 0);
    let totalDropped = 0;
    for (const c of wss.clients) totalDropped += dropCounts.get(c) ?? 0;

    console.log(`  -- ${mode} done --`);
    console.log(`  RSS:    ${fmtMB(rssStart)} -> ${fmtMB(rssEnd)}   delta=${fmtMB(rssEnd - rssStart)}`);
    console.log(`  Heap:   ${fmtMB(heapStart)} -> ${fmtMB(heapEnd)}   delta=${fmtMB(heapEnd - heapStart)}`);
    console.log(`  Buffered (sum across clients): ${fmtMB(totalBuffered)}`);
    console.log(`  Dropped frames: ${totalDropped}`);

    for (const c of clients) c.terminate();
    wss.close();
    await new Promise(r => httpServer.close(r));

    return { mode, rssDelta: rssEnd - rssStart, heapDelta: heapEnd - heapStart, buffered: totalBuffered, dropped: totalDropped };
}

const r1 = await run('unguarded');
if (global.gc) global.gc();
await new Promise(r => setTimeout(r, 500));
const r2 = await run('guarded');

console.log('\n=== Verdict ===');
console.log(`unguarded: rssDelta=${fmtMB(r1.rssDelta)}  buffered=${fmtMB(r1.buffered)}  dropped=${r1.dropped}`);
console.log(`guarded:   rssDelta=${fmtMB(r2.rssDelta)}  buffered=${fmtMB(r2.buffered)}  dropped=${r2.dropped}`);

if (r2.dropped > 0 && r2.buffered <= WS_BACKPRESSURE_BYTES * 4 && r1.dropped === 0) {
    console.log('\nPASS: guard prevents unbounded buffering (drops engaged, buffered stays near cap).');
    process.exit(0);
} else {
    console.log('\nFAIL: guard did not behave as expected.');
    process.exit(1);
}
