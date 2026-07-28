// Smoke-test the Debug Dashboard panel API.
// Posts all four widget types to LogHub and animates them so you can watch the
// dashboard update in-place (open the Viewer's Live tab first).
//
//   node scripts/test-panel.mjs            # animate ~15s
//   node scripts/test-panel.mjs 1000 50    # 1000 plot updates/s burst (backpressure test)

const PORT = process.env.LOGHUB_PORT || '3335';
const URL = `http://localhost:${PORT}/panel`;
const burstRate = Number(process.argv[2]) || 0;     // plot updates/sec for burst mode
const burstSecs = Number(process.argv[3]) || 0;

async function post(body) {
    try {
        await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { /* loghub down — ignore */ }
}

async function defineWidgets() {
    await post({ id: 'fps', type: 'label', value: 60, unit: 'fps', group: 'Engine', label: 'Frame Rate', color: 'green', order: 0 });
    await post({ id: 'state', type: 'gauge', value: 'ok', group: 'Engine', label: 'State', order: 1 });
    await post({ id: 'buffer', type: 'progress', value: 0, min: 0, max: 100, unit: '%', warn: 70, crit: 90, group: 'Engine', label: 'Buffer Fill', order: 2 });
    await post({ id: 'gpu_temp', type: 'gauge', value: 45, min: 0, max: 100, unit: '°C', warn: 75, crit: 90, group: 'Hardware', label: 'GPU Temp', order: 0 });
    await post({ id: 'gpu_load', type: 'gauge', value: 30, min: 0, max: 100, unit: '%', warn: 80, crit: 95, group: 'Hardware', label: 'GPU Load', order: 1 });
    await post({ id: 'mic_level', type: 'plot', value: 0, group: 'Audio', label: 'Mic Level', color: 'cyan', unit: 'dB', order: 0 });
    await post({ id: 'latency', type: 'plot', value: 0, group: 'Network', label: 'Latency', color: 'orange', unit: 'ms', order: 0 });
}

async function animate() {
    await defineWidgets();
    console.log('Widgets defined. Animating ~15s — watch the Live tab.');
    const t0 = Date.now();
    let i = 0;
    const timer = setInterval(async () => {
        const t = (Date.now() - t0) / 1000;
        i++;
        await post({ id: 'fps', value: Math.round(58 + Math.sin(t) * 4) });
        await post({ id: 'buffer', value: Math.round((Math.sin(t / 2) * 0.5 + 0.5) * 100) });
        await post({ id: 'gpu_temp', value: Math.round(45 + (Math.sin(t / 3) * 0.5 + 0.5) * 50) });
        await post({ id: 'gpu_load', value: Math.round((Math.sin(t / 1.5) * 0.5 + 0.5) * 100) });
        await post({ id: 'mic_level', value: +(Math.sin(t * 4) * Math.exp(-((t % 2)) ) * 20).toFixed(2) });
        await post({ id: 'latency', value: +(12 + Math.random() * 8 + Math.sin(t) * 3).toFixed(1) });
        // Cycle the status LED.
        if (i % 30 === 0) await post({ id: 'state', value: ['ok', 'warn', 'error'][(i / 30) % 3 | 0] });
        if (t > 15) { clearInterval(timer); console.log('Done.'); }
    }, 100);
}

async function burst() {
    await post({ id: 'mic_level', type: 'plot', value: 0, group: 'Audio', label: 'Mic Level (burst)', color: 'cyan' });
    const total = burstRate * burstSecs;
    console.log(`Burst: ${total} plot updates at ${burstRate}/s (backpressure test).`);
    const gap = 1000 / burstRate;
    let n = 0;
    const t0 = Date.now();
    const timer = setInterval(async () => {
        const t = (Date.now() - t0) / 1000;
        await post({ id: 'mic_level', value: +(Math.sin(t * 20) * 50).toFixed(2) });
        if (++n >= total) { clearInterval(timer); console.log(`Sent ${n} updates.`); }
    }, gap);
}

if (burstRate > 0 && burstSecs > 0) burst();
else animate();
