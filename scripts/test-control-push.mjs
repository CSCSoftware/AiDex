// End-to-end test for control PUSH (POST /control/subscribe). Self-contained:
// starts its own Log Hub from build/ on a spare port, plays the part of a
// source with its own HTTP server, and checks what the hub delivers there.
// No running AiDex needed.
//
//   npm run build && node scripts/test-control-push.mjs

import { createServer } from 'http';
import { initLogHub, freeLogHub, getControlSubscribers, getLogBuffer } from '../build/loghub/log-server.js';
import { validateCallbackUrl, normalizeRemoteAddress } from '../build/loghub/control-push.js';

const HUB_PORT = 3399;
const BASE = `http://127.0.0.1:${HUB_PORT}`;

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function post(path, body) {
    const r = await fetch(BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* no body */ }
    return { status: r.status, json };
}

// A fake source: records every push it receives. `delayMs` simulates a slow device.
function startSource({ delayMs = 0, status = 200 } = {}) {
    const received = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            received.push({ path: req.url, body: JSON.parse(body || '{}') });
            setTimeout(() => { res.statusCode = status; res.end('ok'); }, delayMs);
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
        resolve({ server, received, port: server.address().port })));
}

async function main() {
    console.log('=== Unit: URL validation ===');
    check('private IPv4 accepted', 'url' in validateCallbackUrl('http://192.168.1.50/control'));
    check('10.x accepted', 'url' in validateCallbackUrl('http://10.0.0.7:8080/x'));
    check('localhost accepted', 'url' in validateCallbackUrl('http://localhost:9000/'));
    check('public IPv4 rejected', 'error' in validateCallbackUrl('http://8.8.8.8/'));
    check('DNS name rejected', 'error' in validateCallbackUrl('http://evil.example.com/'));
    check('https rejected', 'error' in validateCallbackUrl('https://192.168.1.5/'));
    check('file: rejected', 'error' in validateCallbackUrl('file:///etc/passwd'));
    check('credentials rejected', 'error' in validateCallbackUrl('http://a:b@192.168.1.5/'));
    check('172.32 rejected', 'error' in validateCallbackUrl('http://172.32.0.1/'));
    check('mapped private v6 accepted', 'url' in validateCallbackUrl('http://[::ffff:192.168.1.5]/'));
    check('mapped public v6 rejected', 'error' in validateCallbackUrl('http://[::ffff:8.8.8.8]/'));
    check('::1 accepted', 'url' in validateCallbackUrl('http://[::1]:80/'));
    check('normalize ::ffff:a.b.c.d', normalizeRemoteAddress('::ffff:192.168.1.50') === '192.168.1.50');
    check('normalize strips zone id', normalizeRemoteAddress('fe80::1%eth0') === 'fe80::1');
    check('normalize garbage -> null', normalizeRemoteAddress('nope') === null);

    await initLogHub({ port: HUB_PORT, bufferSize: 500, persist: false });
    try {
        console.log('=== HTTP: subscribe + delivery ===');
        await post('/panel', { id: 'p_gain', type: 'slider', value: 5, min: 0, max: 100, group: '_t' });
        await post('/panel', { id: 'p_btn', type: 'button', group: '_t' });
        await post('/panel', { id: 'p_other', type: 'toggle', value: 0, group: '_t' });

        const src = await startSource();
        // Port-only form: the hub must call back the SENDER's address.
        let r = await post('/control/subscribe', { port: src.port, path: 'cb', ids: ['p_gain', 'p_btn'] });
        check('subscribe by port -> 200', r.status === 200);
        check('url built from sender ip', r.json?.url === `http://127.0.0.1:${src.port}/cb`);
        const url = r.json.url;

        r = await post('/control/subscribe', { url: 'http://8.8.8.8/x' });
        check('public callback -> 400', r.status === 400);
        r = await post('/control/subscribe', {});
        check('empty subscribe -> 400', r.status === 400);

        await post('/control', { id: 'p_gain', value: 42 });
        await wait(150);
        check('slider change pushed', src.received.length === 1 && src.received[0].body.p_gain === 42);
        check('pushed to the given path', src.received[0]?.path === '/cb');

        await post('/control/press', { id: 'p_btn' });
        await wait(150);
        check('button press pushed as counter', src.received.at(-1)?.body.p_btn === 1);

        const before = src.received.length;
        await post('/control', { id: 'p_other', value: 1 });
        await wait(150);
        check('id filter: unsubscribed id not pushed', src.received.length === before);

        // GET /control still works — push is additive.
        const g = await (await fetch(BASE + '/control')).json();
        check('GET /control still serves values', g.p_gain === 42 && g.p_btn === 1 && g.p_other === 1);

        console.log('=== Coalescing with a slow source ===');
        const slow = await startSource({ delayMs: 300 });
        await post('/control/subscribe', { url: `http://127.0.0.1:${slow.port}/`, ids: ['p_gain'] });
        const t0 = Date.now();
        for (let v = 1; v <= 20; v++) await post('/control', { id: 'p_gain', value: v });
        const elapsed = Date.now() - t0;
        check(`dashboard requests not blocked by slow source (${elapsed} ms for 20)`, elapsed < 1000);
        await wait(900);
        const vals = slow.received.map(x => x.body.p_gain);
        check(`coalesced: ${vals.length} deliveries for 20 changes`, vals.length <= 3);
        check('last delivered value is the latest (no reordering)', vals.at(-1) === 20);

        console.log('=== Dead source gets dropped ===');
        const dead = await startSource();
        const deadUrl = `http://127.0.0.1:${dead.port}/`;
        await post('/control/subscribe', { url: deadUrl, ids: ['p_btn'] });
        await new Promise(r => dead.server.close(r));
        for (let i = 0; i < 3; i++) { await post('/control/press', { id: 'p_btn' }); await wait(200); }
        check('dead subscriber dropped after 3 failures',
            !getControlSubscribers().some(s => s.url === deadUrl));
        const logged = getLogBuffer().query({ source: 'loghub', limit: 50 }) ?? [];
        check('drop is logged as warn',
            logged.some(e => e.level === 'warn' && e.message.includes('dropped')));

        console.log('=== Re-subscribe + unsubscribe ===');
        r = await post('/control/subscribe', { port: src.port, path: 'cb', ids: ['p_gain', 'p_btn'] });
        check('re-subscribe is idempotent', r.status === 200
            && getControlSubscribers().filter(s => s.url === url).length === 1);
        r = await post('/control/unsubscribe', { url });
        check('unsubscribe -> removed', r.json?.removed === true);
        const n = src.received.length;
        await post('/control', { id: 'p_gain', value: 77 });
        await wait(150);
        check('no push after unsubscribe', src.received.length === n);

        src.server.close(); slow.server.close();
    } finally {
        freeLogHub();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); freeLogHub(); process.exit(1); });
