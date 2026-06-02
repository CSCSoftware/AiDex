// HTTP end-to-end test for the panel API against a running Log Hub.
// Requires the hub to be up (aidex_log init). Uses a throwaway group so it
// won't disturb a running demo, and cleans up its own widgets at the end.
//
//   node scripts/test-panel-http.mjs            # default port 3335
//   LOGHUB_PORT=3336 node scripts/test-panel-http.mjs

const PORT = process.env.LOGHUB_PORT || '3335';
const BASE = `http://localhost:${PORT}`;
const GROUP = '_test_http';

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

async function main() {
    // Reachability.
    try {
        const h = await fetch(BASE + '/health');
        if (!h.ok) throw new Error('health not ok');
    } catch {
        console.log(`Log Hub not reachable on ${BASE} — start it (aidex_log init) first.`);
        process.exit(2);
    }
    console.log(`=== Panel HTTP tests against ${BASE} ===`);

    // Single valid widget.
    let r = await post('/panel', { id: 't_label', type: 'label', value: 42, group: GROUP });
    check('POST /panel valid -> 201', r.status === 201 && r.json && r.json.id === 't_label');

    // Invalid: missing type on new id.
    r = await post('/panel', { id: 't_bad', value: 1 });
    check('POST /panel value-only new id -> 400', r.status === 400);

    // Invalid: bad type.
    r = await post('/panel', { id: 't_bad2', type: 'nope', value: 1 });
    check('POST /panel bad type -> 400', r.status === 400);

    // Batch.
    r = await post('/panels', [
        { id: 't_g', type: 'gauge', value: 50, group: GROUP },
        { id: 't_p', type: 'plot', value: 0.5, group: GROUP },
        { id: 't_pr', type: 'progress', value: 80, group: GROUP },
    ]);
    check('POST /panels batch -> 201 count 3', r.status === 201 && r.json.count === 3);

    // Batch with a bad entry mixed in — good ones still ingested.
    r = await post('/panels', [
        { id: 't_g2', type: 'gauge', value: 10, group: GROUP },
        { bad: true },
    ]);
    check('POST /panels skips bad entry', r.status === 201 && r.json.count === 1);

    // Non-array body to /panels.
    r = await post('/panels', { id: 'x', type: 'label', value: 1 });
    check('POST /panels non-array -> 400', r.status === 400);

    // Update existing (value-only) succeeds.
    r = await post('/panel', { id: 't_label', value: 99 });
    check('POST /panel update existing -> 201', r.status === 201);

    // Clear one.
    r = await post('/panel/clear', { id: 't_label' });
    check('POST /panel/clear {id} -> 200', r.status === 200 && r.json.cleared === 't_label');

    // Clean up the rest of our test widgets (clear-all would nuke a running demo,
    // so remove ours individually).
    for (const id of ['t_g', 't_p', 't_pr', 't_g2']) {
        await post('/panel/clear', { id });
    }
    console.log('  (cleaned up test widgets)');

    console.log('');
    console.log(`=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
}

main();
