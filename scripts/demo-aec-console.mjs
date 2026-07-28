// AiDex Debug Dashboard — AEC Tuning Console showcase.
//
// A polished, "live system" demo modelled on the real GeminiPod satellite
// (ucwebapp Tools/UcHome): three audio waveform plots driven by an echo
// canceller, plus a row of interactive sliders/numbers that the user (or the
// AI, via aidex_log control_set) tunes — and the waveforms react to in real
// time. This is the screenshot subject for the Panel-Dashboard guide.
//
//   node scripts/demo-aec-console.mjs            # default port 3335
//   LOGHUB_PORT=3336 node scripts/demo-aec-console.mjs
//
// Open the viewer's Live tab to watch:  aidex_viewer({ path: "." })
//
// The waveforms are SENT AS FULL ARRAY FRAMES (value:[...]) the way the real
// satellite sends them — 200 int16 samples per frame, the server's PLOT_HISTORY
// cap. min/max are the real bipolar audio range so the curves sit naturally.

const PORT = process.env.LOGHUB_PORT || '3335';
const BASE = `http://localhost:${PORT}`;
const TICK_MS = 70;            // frame cadence — smooth without flooding
const N = 200;                 // samples per waveform frame (= PLOT_HISTORY)
const FULL = 32767;            // int16 full-scale (bipolar audio)

let alive = true;
let tick = 0;

// Local mirror of the tunables. The viewer changes these via the sliders; we
// poll GET /control and copy them back here, exactly like the satellite copies
// them into its live int*. Start values match the real GeminiPod registration.
const ctl = {
    ww_thresh:   650,   // wake-word threshold   400..950
    spk_vol:     70,    // speaker volume %       20..100
    mic_gain:    21,    // mic gain idle           0..37
    mic_gain_pb: 9,     // mic gain playback       0..37
    ref_boost:   24,    // AEC reference boost     1..256
    up_hold:     400,   // uplink hold ms          0..1500
};

async function post(path, body) {
    try {
        await fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch { /* loghub not running — ignore */ }
}
const panels = (arr) => post('/panels', arr);
async function clearAll() { await post('/panel/clear', {}); }

// Pull the set-points the user dialled in and mirror them locally (clamped).
async function pollControls() {
    try {
        const res = await fetch(`${BASE}/control`);
        if (!res.ok) return;
        const map = await res.json();
        for (const k of Object.keys(ctl)) {
            if (typeof map[k] === 'number') ctl[k] = map[k];
        }
    } catch { /* ignore */ }
}

// One-time widget definitions: three AEC waveform plots + the tuning knobs +
// a few status widgets so the board reads like a real running system.
async function defineWidgets() {
    await panels([
        // --- 1 AEC: the three waveform plots (the stars of the screenshot) ---
        { id: 'spk_wave',   type: 'plot', group: '1 AEC', label: 'Speaker out',      scale: 'linear', min: -FULL, max: FULL, decimals: 0, color: 'orange', order: 0 },
        { id: 'slot0_wave', type: 'plot', group: '1 AEC', label: 'Mic raw',          scale: 'linear', min: -FULL, max: FULL, decimals: 0, color: 'cyan',   order: 1 },
        { id: 'clean_wave', type: 'plot', group: '1 AEC', label: 'CLEAN (post-AEC)', scale: 'linear', min: -FULL, max: FULL, decimals: 0, color: 'green',  order: 2 },

        // --- 2 Levels: live meters that move with the tuning ---
        { id: 'mic_rms',  type: 'plot',     group: '2 Levels', label: 'Mic level',  scale: 'log', autoMin: true, min: 1, max: FULL, decimals: 0, color: 'cyan',   order: 0 },
        { id: 'erle',     type: 'gauge',    group: '2 Levels', label: 'ERLE',       unit: 'dB', min: 0, max: 40, warn: 12, crit: 6, color: 'green', order: 1 },
        { id: 'speech',   type: 'progress', group: '2 Levels', label: 'Speech prob', min: 0, max: 100, unit: '%', color: 'purple', order: 2 },

        // --- 3 Status: it looks alive ---
        { id: 'mode',     type: 'gauge', group: '3 Status', label: 'Pipeline', value: 'ok',   order: 0 },
        { id: 'wakeword', type: 'gauge', group: '3 Status', label: 'Wake word', min: 0, max: 100, warn: 60, crit: 85, order: 1 },
        { id: 'rtt',      type: 'label', group: '3 Status', label: 'Uplink RTT', unit: 'ms', color: 'blue', order: 2 },
        { id: 'uptime',   type: 'label', group: '3 Status', label: 'Uptime',     unit: 's',  color: 'cyan', order: 3 },

        // --- 4 Tuning: the interactive knobs (slider/number) ---
        { id: 'ww_thresh',   type: 'slider', group: '4 Tuning', label: 'Wake-word thresh', value: ctl.ww_thresh,   min: 400, max: 950,  step: 10, color: 'purple', order: 0 },
        { id: 'spk_vol',     type: 'slider', group: '4 Tuning', label: 'Speaker volume',   value: ctl.spk_vol,     min: 20,  max: 100,  step: 5,  unit: '%', color: 'orange', order: 1 },
        { id: 'mic_gain',    type: 'slider', group: '4 Tuning', label: 'Mic gain (idle)',  value: ctl.mic_gain,    min: 0,   max: 37,   step: 1,  color: 'cyan',   order: 2 },
        { id: 'mic_gain_pb', type: 'slider', group: '4 Tuning', label: 'Mic gain (play)',  value: ctl.mic_gain_pb, min: 0,   max: 37,   step: 1,  color: 'cyan',   order: 3 },
        { id: 'ref_boost',   type: 'number', group: '4 Tuning', label: 'AEC ref boost',    value: ctl.ref_boost,   min: 1,   max: 256,  step: 1,  color: 'green',  order: 4 },
        { id: 'up_hold',     type: 'number', group: '4 Tuning', label: 'Uplink hold',      value: ctl.up_hold,     min: 0,   max: 1500, step: 50, unit: 'ms', color: 'blue', order: 5 },
    ]);
}

// ── Signal model — waveforms that visibly depend on the knobs ────────────────
// Speaker plays a gently drifting tone+harmonic; mic = attenuated echo of the
// speaker + the user's speech + noise; CLEAN = mic with the echo removed by the
// (ref_boost-tuned) canceller. So: spk_vol scales the speaker, mic_gain scales
// the whole mic, ref_boost decides how much echo survives in CLEAN.
function buildFrames(t) {
    const spk = new Array(N), mic = new Array(N), clean = new Array(N);

    const spkAmp = (ctl.spk_vol / 100);                 // 0.2 .. 1.0
    const micG   = 0.25 + (ctl.mic_gain / 37) * 0.9;    // idle-gain influence
    const leak   = Math.max(0.02, 1 - ctl.ref_boost / 256); // echo left after AEC
    const speechOn = (Math.sin(t / 2.3) > 0.25) ? 1 : 0;    // bursts of speech
    const f1 = 3.0 + Math.sin(t * 0.13) * 0.4;          // slowly drifting pitch

    for (let i = 0; i < N; i++) {
        const p = i / N;
        const ph = (p * Math.PI * 2);

        // Speaker: fundamental + a softer 2nd harmonic, scaled by volume.
        const s = (Math.sin(ph * f1) * 0.7 + Math.sin(ph * f1 * 2) * 0.3) * spkAmp;
        spk[i] = clamp16(s * 0.92 * FULL);

        // Mic: echo of the speaker (delayed a touch) + speech + noise, all *micG.
        const echo   = (Math.sin((ph - 0.6) * f1) * 0.7 + Math.sin((ph - 0.6) * f1 * 2) * 0.3) * spkAmp * 0.8;
        const speech = speechOn * Math.sin(ph * (5.5 + Math.sin(t) * 0.5)) * 0.5 *
                       (0.6 + 0.4 * Math.sin(p * Math.PI));            // word-shaped envelope
        const noise  = (Math.random() - 0.5) * 0.05;
        const m = (echo + speech + noise) * micG;
        mic[i] = clamp16(m * 0.95 * FULL);

        // CLEAN: subtract (most of) the echo — what's left is speech + a little
        // residual echo (leak) + noise. This is the curve that gets visibly
        // cleaner as ref_boost goes up.
        const c = (speech + echo * leak + noise) * micG;
        clean[i] = clamp16(c * 0.95 * FULL);
    }
    return { spk, mic, clean, speechOn, leak, micG, spkAmp };
}
function clamp16(v) { v = Math.round(v); return v > FULL ? FULL : v < -FULL ? -FULL : v; }
function rms(arr) { let s = 0; for (const v of arr) s += v * v; return Math.sqrt(s / arr.length); }

async function update() {
    const t = tick * (TICK_MS / 1000);
    tick++;

    const { spk, mic, clean, speechOn, leak, micG } = buildFrames(t);

    // The three waveforms as full array frames (the satellite's exact pattern).
    await panels([
        { id: 'spk_wave',   value: spk },
        { id: 'slot0_wave', value: mic },
        { id: 'clean_wave', value: clean },
    ]);

    // Derived live meters.
    const micRms   = Math.max(1, rms(mic));
    const cleanRms = Math.max(1, rms(clean));
    // ERLE = echo return loss enhancement: how much the AEC reduced the echo.
    const erle = Math.min(40, Math.max(0, 20 * Math.log10(micRms / cleanRms) + (1 - leak) * 18));
    const speechProb = speechOn ? Math.round(60 + Math.random() * 35) : Math.round(Math.random() * 25);

    await panels([
        { id: 'mic_rms', value: Math.round(micRms) },
        { id: 'erle',    value: +erle.toFixed(1) },
        { id: 'speech',  value: speechProb },
        { id: 'wakeword', value: speechProb > ((ctl.ww_thresh - 400) / 550 * 100)
                                  ? Math.round(70 + Math.random() * 30)
                                  : Math.round(Math.random() * 40) },
        { id: 'rtt',     value: Math.round(18 + Math.sin(t * 1.7) * 6 + Math.random() * 3) },
        { id: 'uptime',  value: Math.round(t) },
    ]);

    // Pipeline LED: mostly ok, a rare warn — keeps the board honest-looking.
    if (tick % 60 === 0) {
        await panels([{ id: 'mode', value: Math.random() > 0.85 ? 'warn' : 'ok' }]);
    }
}

async function main() {
    console.log(`AEC Tuning Console demo → ${BASE}`);
    console.log('Open the Viewer Live tab to watch. Drag the Tuning sliders — the waveforms react.');
    console.log('Press Ctrl+C to stop.\n');
    await defineWidgets();

    const stop = async () => {
        if (!alive) return;
        alive = false;
        console.log('\nStopping demo, clearing dashboard...');
        await clearAll();
        process.exit(0);
    };
    // SIGHUP/SIGBREAK cover closing the terminal window and Ctrl+Break on Windows.
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
    process.on('SIGBREAK', stop);

    // Drive frames + poll the knobs on the same loop (poll every ~3rd frame).
    let n = 0;
    while (alive) {
        await update();
        if (n++ % 3 === 0) await pollControls();
        await new Promise(r => setTimeout(r, TICK_MS));
    }
}

main();
