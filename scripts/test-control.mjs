// HTTP end-to-end test for the generic Control back-channel against a running
// Log Hub. Mirrors test-panel-http.mjs in style. Requires the hub to be up
// (aidex_log init). Uses a throwaway group + ids and cleans up after itself.
//
//   node scripts/test-control.mjs            # default port 3335
//   LOGHUB_PORT=3336 node scripts/test-control.mjs

const PORT = process.env.LOGHUB_PORT || '3335';
const BASE = `http://localhost:${PORT}`;
const GROUP = '_test_control';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name); }
}

async function post(path, body) {
    const r = await fetch(BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* no body */ }
    return { status: r.status, json };
}

async function getControl() {
    const r = await fetch(BASE + '/control');
    return { status: r.status, json: await r.json() };
}

async function main() {
    try {
        const h = await fetch(BASE + '/health');
        if (!h.ok) throw new Error('health not ok');
    } catch {
        console.log(`Log Hub not reachable on ${BASE} — start it (aidex_log init) first.`);
        process.exit(2);
    }
    console.log(`=== Control back-channel tests against ${BASE} ===`);

    // Define a slider control — the store should seed it with its start value.
    let r = await post('/panel', {
        id: 'c_floor', type: 'slider', value: 700, min: 0, max: 4000, step: 50,
        label: 'Floor', group: GROUP,
    });
    check('POST /panel slider -> 201', r.status === 201 && r.json && r.json.id === 'c_floor');

    // Define a number (spin) control.
    r = await post('/panel', {
        id: 'c_boost', type: 'number', value: 64, min: 1, max: 128, step: 1,
        label: 'Boost', group: GROUP,
    });
    check('POST /panel number -> 201', r.status === 201);

    // GET /control reflects both seeded defaults.
    let g = await getControl();
    check('GET /control -> 200', g.status === 200);
    check('GET /control seeds slider default 700', g.json.c_floor === 700);
    check('GET /control seeds number default 64', g.json.c_boost === 64);

    // User changes the slider — POST /control sets the new value.
    r = await post('/control', { id: 'c_floor', value: 900 });
    check('POST /control set -> 200', r.status === 200 && r.json.value === 900);

    // GET reflects the change (this is what the source polls).
    g = await getControl();
    check('GET /control reflects new value 900', g.json.c_floor === 900);

    // Re-defining the widget (e.g. source reboot) must NOT clobber the user's value.
    r = await post('/panel', { id: 'c_floor', type: 'slider', value: 700, min: 0, max: 4000, group: GROUP });
    g = await getControl();
    check('re-define widget keeps user value (still 900)', g.json.c_floor === 900);

    // Invalid: missing value.
    r = await post('/control', { id: 'c_floor' });
    check('POST /control no value -> 400', r.status === 400);

    // Invalid: non-finite number.
    r = await post('/control', { id: 'c_floor', value: 'NaN-not-a-number' });
    // string is technically allowed by the store; ensure a real bad number is rejected.
    r = await post('/control', { id: 'c_floor', value: Number.POSITIVE_INFINITY });
    check('POST /control infinite value -> 400', r.status === 400);

    // String value is accepted (generic store — future text/select controls).
    r = await post('/control', { id: 'c_text', value: 'hello' });
    check('POST /control string value -> 200', r.status === 200);
    g = await getControl();
    check('GET /control returns string value', g.json.c_text === 'hello');

    // Clean up.
    for (const id of ['c_floor', 'c_boost', 'c_text']) {
        await post('/panel/clear', { id });
    }
    g = await getControl();
    check('clear removes control values', g.json.c_floor === undefined && g.json.c_boost === undefined);
    console.log('  (cleaned up test controls)');

    console.log('');
    console.log(`=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
}

main();
