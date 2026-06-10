// Tests the AI-side control path: the aidex_log command's control_get /
// control_set actions, which the MCP tool calls. This is the channel the AI
// uses to read and change dashboard controls DIRECTLY (no HTTP, no dashboard).
// Runs against the locally built code (build/). No running hub needed for the
// command itself — it manages its own hub via init/free.
//
//   node scripts/test-control-mcp.mjs

import { log } from '../build/commands/log.js';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name); }
}

async function main() {
    console.log('=== aidex_log control actions (AI side) ===');

    // Start a hub on a throwaway port so we don't collide with a running one.
    const port = 3399;
    let r = await log({ action: 'init', port, buffer_size: 100, persist: false });
    check('init -> success', r.success === true);

    // control_get with no controls yet -> empty map.
    r = await log({ action: 'control_get' });
    check('control_get empty -> {}', r.success && r.controls && Object.keys(r.controls).length === 0);

    // Define a control via the HTTP /panels route (the source's job). We POST
    // to the hub we just started.
    const base = `http://localhost:${port}`;
    await fetch(base + '/panel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'barge_floor', type: 'slider', value: 700, min: 0, max: 4000, step: 50, group: '6 Tuning' }),
    });

    // Now the AI sees it.
    r = await log({ action: 'control_get' });
    check('control_get sees seeded control 700', r.success && r.controls.barge_floor === 700);

    // AI changes it directly — the core of Uwe's requirement.
    r = await log({ action: 'control_set', id: 'barge_floor', value: 1100 });
    check('control_set -> success', r.success === true);
    check('control_set returns updated map (1100)', r.controls.barge_floor === 1100);

    // GET /control over HTTP reflects the AI's change too (this is what the Pod polls).
    const httpVal = await (await fetch(base + '/control')).json();
    check('HTTP GET /control reflects AI change (1100)', httpVal.barge_floor === 1100);

    // Bad inputs.
    r = await log({ action: 'control_set', id: '', value: 5 });
    check('control_set empty id -> fail', r.success === false);
    r = await log({ action: 'control_set', id: 'barge_floor' });
    check('control_set no value -> fail', r.success === false);

    await log({ action: 'free' });
    check('free -> success', true);

    console.log('');
    console.log(`=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
}

main();
