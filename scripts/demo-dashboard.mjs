// AiDex Debug Dashboard — showcase demo (endless loop).
//
// A polished, repeatable demo of the live debug dashboard. Runs until you press
// Ctrl+C. Animates all four widget types across several groups with realistic,
// "breathing" values — gauges wander through their green/yellow/red zones so the
// threshold colouring is visible, plots scroll smoothly.
//
//   node scripts/demo-dashboard.mjs              # default port 3335
//   LOGHUB_PORT=3336 node scripts/demo-dashboard.mjs
//
// Open the viewer's Debug tab to watch:  aidex_viewer({ path: "." })
// (or use scripts/demo-dashboard.ps1 which starts everything for you).

const PORT = process.env.LOGHUB_PORT || '3335';
const BASE = `http://localhost:${PORT}`;
const TICK_MS = 60;          // ~16 fps update cadence (plots feel smooth)

let alive = true;
let tick = 0;

async function panel(body) {
    try {
        await fetch(`${BASE}/panel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch { /* loghub not running — ignore */ }
}
async function clearAll() {
    try {
        await fetch(`${BASE}/panel/clear`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
    } catch { /* ignore */ }
}

// One-time widget definitions (id, type, layout, thresholds, colour).
async function defineWidgets() {
    // --- Audio ---
    await panel({ id: 'mic',      type: 'plot',     group: 'Audio', label: 'Microphone',  color: 'cyan',   unit: 'dB', order: 0 });
    await panel({ id: 'speech',   type: 'progress', group: 'Audio', label: 'Speech Prob', color: 'purple', min: 0, max: 1, order: 1 });
    await panel({ id: 'wakeword', type: 'gauge',    group: 'Audio', label: 'Wake Word',   order: 2 });

    // --- Engine ---
    await panel({ id: 'fps',    type: 'label',    group: 'Engine', label: 'Frame Rate', color: 'green', unit: 'fps', order: 0 });
    await panel({ id: 'state',  type: 'gauge',    group: 'Engine', label: 'Pipeline',   order: 1 });
    await panel({ id: 'buffer', type: 'progress', group: 'Engine', label: 'Buffer Fill', unit: '%', min: 0, max: 100, warn: 70, crit: 90, order: 2 });

    // --- Hardware ---
    await panel({ id: 'gpu_temp', type: 'gauge', group: 'Hardware', label: 'GPU Temp', unit: '°C', min: 0, max: 100, warn: 75, crit: 90, order: 0 });
    await panel({ id: 'gpu_load', type: 'gauge', group: 'Hardware', label: 'GPU Load', unit: '%',  min: 0, max: 100, warn: 80, crit: 95, order: 1 });
    await panel({ id: 'vram',     type: 'progress', group: 'Hardware', label: 'VRAM',  unit: 'GB', min: 0, max: 24, warn: 18, crit: 22, order: 2 });

    // --- Network ---
    await panel({ id: 'latency', type: 'plot',  group: 'Network', label: 'Latency',    color: 'orange', unit: 'ms', order: 0 });
    await panel({ id: 'rps',     type: 'label', group: 'Network', label: 'Requests/s', color: 'blue',   unit: 'req', order: 1 });

    // --- System (4 extra demo widgets) ---
    await panel({ id: 'cpu',    type: 'gauge',    group: 'System', label: 'CPU Load', unit: '%',  min: 0, max: 100, warn: 70, crit: 90, order: 0 });
    await panel({ id: 'ram',    type: 'progress', group: 'System', label: 'RAM',      unit: 'GB', min: 0, max: 64, warn: 48, crit: 58, order: 1 });
    await panel({ id: 'diskio', type: 'plot',     group: 'System', label: 'Disk I/O', color: 'green', unit: 'MB/s', order: 2 });
    await panel({ id: 'uptime', type: 'label',    group: 'System', label: 'Uptime',   color: 'cyan', unit: 's', order: 3 });
}

function update() {
    const t = tick * (TICK_MS / 1000);   // seconds
    tick++;

    // Slow envelopes so gauges drift through their zones over ~20-40s.
    const slow = (period, phase = 0) => Math.sin((t / period) * Math.PI * 2 + phase) * 0.5 + 0.5; // 0..1

    // Audio: a noisy waveform with occasional "speech bursts".
    const burst = slow(8) > 0.6 ? 1 : 0.15;
    const mic = Math.sin(t * 9) * 18 * burst + (Math.random() - 0.5) * 6;
    panel({ id: 'mic', value: +mic.toFixed(2) });
    const speech = Math.min(1, burst * (0.6 + Math.random() * 0.4));
    panel({ id: 'speech', value: +speech.toFixed(2) });
    // Wake-word confidence rises during a burst; gauge 0..100.
    panel({ id: 'wakeword', value: Math.round(speech > 0.7 ? 70 + Math.random() * 30 : Math.random() * 40), min: 0, max: 100, warn: 60, crit: 85 });

    // Engine.
    panel({ id: 'fps', value: Math.round(58 + Math.sin(t * 1.3) * 4) });
    panel({ id: 'buffer', value: Math.round(slow(11) * 100) });
    // Pipeline state LED: mostly ok, occasional warn, rare error.
    if (tick % 50 === 0) {
        const r = Math.random();
        panel({ id: 'state', value: r > 0.85 ? 'error' : r > 0.6 ? 'warn' : 'ok' });
    }

    // Hardware: temp/load track each other, climbing into the red now and then.
    const load = slow(17) * 100;
    panel({ id: 'gpu_load', value: Math.round(load) });
    panel({ id: 'gpu_temp', value: Math.round(40 + load * 0.55 + Math.sin(t * 2) * 2) });
    panel({ id: 'vram', value: +(8 + slow(23) * 14).toFixed(1) });

    // Network.
    const lat = 12 + slow(7) * 10 + (Math.random() < 0.04 ? 40 : 0) + Math.random() * 4; // occasional spike
    panel({ id: 'latency', value: +lat.toFixed(1) });
    panel({ id: 'rps', value: Math.round(800 + slow(9) * 1200) });

    // System (extra widgets): CPU tracks GPU load loosely; RAM creeps; disk I/O bursts.
    panel({ id: 'cpu', value: Math.round(load * 0.7 + slow(13, 1.2) * 30) });
    panel({ id: 'ram', value: +(20 + slow(29) * 38).toFixed(1) });
    panel({ id: 'diskio', value: +(slow(5) * 80 + (Math.random() < 0.06 ? 200 : 0) + Math.random() * 10).toFixed(1) });
    panel({ id: 'uptime', value: tick * (TICK_MS / 1000) | 0 });
}

async function main() {
    console.log(`AiDex Dashboard demo → ${BASE}`);
    console.log('Open the Viewer Debug tab to watch. Press Ctrl+C to stop.\n');
    await defineWidgets();

    const timer = setInterval(update, TICK_MS);

    const stop = async () => {
        if (!alive) return;
        alive = false;
        clearInterval(timer);
        console.log('\nStopping demo, clearing dashboard...');
        await clearAll();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

main();
