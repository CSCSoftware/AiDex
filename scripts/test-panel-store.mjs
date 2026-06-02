// Unit tests for the panel store (debug dashboard data layer).
// Runs against the built PanelStore directly — no HTTP, no viewer needed.
//
//   node scripts/test-panel-store.mjs
//
// Exit 0 = all pass, exit 1 = a failure.

import { PanelStore } from '../build/loghub/panel-store.js';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name); }
}

console.log('=== PanelStore tests ===');

// --- Creation requires id + type ---
{
    const s = new PanelStore();
    check('reject: no id', s.upsert({ type: 'label', value: 1 }) === null);
    check('reject: empty id', s.upsert({ id: '  ', type: 'label', value: 1 }) === null);
    check('reject: unknown type', s.upsert({ id: 'x', type: 'bogus', value: 1 }) === null);
    check('reject: value-only on new id (no type)', s.upsert({ id: 'x', value: 1 }) === null);
    check('store empty after rejects', s.size === 0);
}

// --- Label create + in-place overwrite ---
{
    const s = new PanelStore();
    const w1 = s.upsert({ id: 'fps', type: 'label', value: 60, unit: 'fps', group: 'Engine' });
    check('label created', w1 && w1.type === 'label' && w1.value === 60);
    check('label defaults: group/label/min/max', w1.group === 'Engine' && w1.label === 'fps' && w1.min === 0 && w1.max === 100);
    const w2 = s.upsert({ id: 'fps', value: 58 });            // value-only update on existing id
    check('label overwrite (value-only ok on existing)', w2.value === 58);
    check('label same instance, size 1', s.size === 1);
    const w3 = s.upsert({ id: 'fps', value: 'idle' });        // string value
    check('label accepts string value', w3.value === 'idle');
}

// --- Progress / gauge carry thresholds ---
{
    const s = new PanelStore();
    const w = s.upsert({ id: 'buf', type: 'progress', value: 80, min: 0, max: 100, warn: 70, crit: 90 });
    check('progress thresholds stored', w.warn === 70 && w.crit === 90);
    const g = s.upsert({ id: 'state', type: 'gauge', value: 'ok' });
    check('gauge accepts status string', g.value === 'ok');
}

// --- Plot: single samples build a ring, array replaces it ---
{
    const s = new PanelStore();
    s.upsert({ id: 'mic', type: 'plot', value: 0.1 });
    s.upsert({ id: 'mic', value: 0.2 });
    s.upsert({ id: 'mic', value: 0.3 });
    let w = s.snapshot().find(x => x.id === 'mic');
    check('plot ring grows with samples', Array.isArray(w.history) && w.history.length === 3);
    check('plot last value tracks latest sample', w.value === 0.3);

    // Array frame replaces history wholesale.
    s.upsert({ id: 'mic', value: [1, 2, 3, 4, 5] });
    w = s.snapshot().find(x => x.id === 'mic');
    check('plot array frame replaces history', w.history.length === 5 && w.value === 5);

    // Ring cap: push more than the history limit (200) and verify it caps.
    const s2 = new PanelStore();
    s2.upsert({ id: 'p', type: 'plot', value: 0 });
    for (let i = 0; i < 500; i++) s2.upsert({ id: 'p', value: i });
    const wp = s2.snapshot().find(x => x.id === 'p');
    check('plot ring capped at 200', wp.history.length === 200);
    check('plot ring keeps newest', wp.history[wp.history.length - 1] === 499);

    // NaN / Infinity rejected.
    const s3 = new PanelStore();
    s3.upsert({ id: 'p', type: 'plot', value: 0 });
    s3.upsert({ id: 'p', value: NaN });
    s3.upsert({ id: 'p', value: Infinity });
    const w3 = s3.snapshot().find(x => x.id === 'p');
    check('plot ignores NaN/Infinity', w3.history.length === 1);
}

// --- Snapshot reflects all widgets ---
{
    const s = new PanelStore();
    s.upsert({ id: 'a', type: 'label', value: 1, group: 'G1' });
    s.upsert({ id: 'b', type: 'gauge', value: 2, group: 'G2' });
    const snap = s.snapshot();
    check('snapshot returns all widgets', snap.length === 2);
    check('snapshot has lastUpdate stamps', snap.every(w => typeof w.lastUpdate === 'number' && w.lastUpdate > 0));
}

// --- Clear: one and all ---
{
    const s = new PanelStore();
    s.upsert({ id: 'a', type: 'label', value: 1 });
    s.upsert({ id: 'b', type: 'label', value: 2 });
    check('clear one returns its id', s.clear('a') === 'a');
    check('size after clear one', s.size === 1);
    check('clear all returns null', s.clear() === null);
    check('store empty after clear all', s.size === 0);
}

// --- Capacity guard ---
{
    const s = new PanelStore();
    for (let i = 0; i < 600; i++) s.upsert({ id: 'w' + i, type: 'label', value: i });
    check('widget count capped at 500', s.size === 500);
}

console.log('');
console.log(`=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
