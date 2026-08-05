/**
 * Task #89 — Provokateur fuer das Handle-Leck im Viewer-Watcher.
 *
 * Startet den Viewer in einem EIGENEN node-Prozess (nicht im MCP-Prozess) und
 * schreibt den eigenen Handle-Zaehler im Sekundentakt mit. Warum eigener Prozess:
 * im MCP-Prozess laufen Viewer und Server zusammen, die Baseline liesse sich
 * zwischen Laeufen nicht zuruecksetzen, und ein /mcp-Neustart wechselt mitten im
 * Lauf die PID. Hier ist die Baseline bei jedem Lauf identisch und die Kurve
 * gehoert garantiert dem Watcher.
 *
 * DIE HYPOTHESE, die gemessen wird:
 *   viewer/server.ts:219 uebergibt chokidar v3-GLOBS ('**\/node_modules/**' usw.),
 *   installiert ist chokidar 5.0.0. Dort ist ein String-Matcher ein EXAKTER
 *   Vergleich (matcher === string, node_modules/chokidar/index.js:24) — die
 *   ignored-Liste greift also NIE. Folge: node_modules/.git/.aidex/build/dist
 *   werden mitbewacht, und v5 legt pro Verzeichnis ein nicht-rekursives fs.watch
 *   an = ein Windows-Directory-Handle.
 *
 * DER BEWEIS liegt NICHT in der absoluten Hoehe, sondern darin, dass die
 * SAETTIGUNG MIT DER PROJEKTGROESSE SKALIERT. Deshalb misst dieses Skript auch
 * die Verzeichnisanzahl des Projekts und stellt beide Zahlen nebeneinander:
 * ein Timer- oder Socket-Leck waere projektunabhaengig.
 *
 * Aufruf:
 *   node scripts/measure-viewer-handles.mjs <projektpfad> [--seconds 180] [--label x] [--no-viewer]
 *
 * Stufen aus der Session-Note (klein -> gross, NIE mit ucwebapp anfangen):
 *   node scripts/measure-viewer-handles.mjs . --label aidex --seconds 180
 *   node scripts/measure-viewer-handles.mjs . --label negativprobe --no-viewer --seconds 120
 *   node scripts/measure-viewer-handles.mjs Q:/develop/Repos/Synthesizers --label synth --seconds 180
 */

import { readdirSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { pathToFileURL } from 'url';

// --- Argumente ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const projectArg = argv.find((a) => !a.startsWith('--')) ?? '.';
const projectPath = resolve(projectArg);
const seconds = Number(flag('seconds', 180));
const intervalMs = Number(flag('interval', 1000));
const noViewer = has('no-viewer');
const label = flag('label', basename(projectPath).toLowerCase());

// --- Verzeichnisse zaehlen ---------------------------------------------------
// Die Bezugsgroesse fuer den Beweis. Zaehlt ALLES, auch node_modules/.git —
// genau das, was chokidar mit der kaputten ignored-Liste eben auch mitnimmt.
function countDirs(root) {
    let total = 0;
    const buckets = { node_modules: 0, '.git': 0, '.aidex': 0, build: 0, dist: 0, rest: 0 };
    const stack = [{ dir: root, bucket: null }];

    while (stack.length) {
        const { dir, bucket } = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue; // unlesbar (Rechte, zu langer Pfad) — ueberspringen
        }
        for (const e of entries) {
            if (!e.isDirectory() || e.isSymbolicLink()) continue;
            total++;
            const own = bucket ?? (Object.hasOwn(buckets, e.name) ? e.name : 'rest');
            buckets[own]++;
            stack.push({ dir: join(dir, e.name), bucket: own });
        }
    }
    return { total: total + 1, buckets }; // +1 = Wurzel selbst
}

console.log(`\n=== Task #89 — Handle-Messung ===`);
console.log(`Projekt : ${projectPath}`);
console.log(`Modus   : ${noViewer ? 'OHNE Viewer (Negativprobe)' : 'MIT Viewer'}`);
console.log(`Dauer   : ${seconds}s, Abtastung ${intervalMs}ms\n`);

process.stdout.write('Zaehle Verzeichnisse ... ');
const dirs = countDirs(projectPath);
console.log(`${dirs.total.toLocaleString('de-DE')}`);
for (const [k, v] of Object.entries(dirs.buckets)) {
    if (v > 0) console.log(`   ${k.padEnd(14)} ${v.toLocaleString('de-DE').padStart(8)}`);
}
console.log('');

// --- CSV ---------------------------------------------------------------------
const outDir = join(import.meta.dirname, 'measurements');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const csvPath = join(outDir, `viewer-${label}-${stamp}.csv`);
writeFileSync(csvPath, 'label,elapsed_s,handles,delta,dirs_total,rss_mb\n');

// --- Handle-Zaehler ----------------------------------------------------------
// GEPRUEFT am 05.08.2026, zwei Sackgassen zuerst ausgeschlossen:
//   - process.report.getReport().header.osHandleCount ist auf diesem Node
//     UNDEFINED. Der naheliegende Fallback auf die libuv-Handles waere still
//     falsch: das sind Event-Loop-Objekte (hier 9), NICHT Windows-Handles.
//   - handle.exe braucht Adminrechte (zeigte im Vorversuch 4 von 184).
// Bleibt Get-Process. Ein einzelner Aufruf kostet aber ~770 ms und macht selbst
// Handles auf — im Sekundentakt waere das Messrauschen groesser als der Effekt.
// Deshalb EIN mitlaufender PowerShell-Prozess, der zyklisch eine Zeile schreibt.
// Der misst nur, er stoert nicht.
const { spawn: rawSpawn } = await import('child_process');

let currentHandles = -1;
const sampler = rawSpawn('powershell', [
    '-NoProfile', '-Command',
    `$p = Get-Process -Id ${process.pid}; while ($true) { $p.Refresh(); if ($p.HasExited) { break }; Write-Output $p.HandleCount; Start-Sleep -Milliseconds ${Math.max(250, Math.floor(intervalMs / 2))} }`
], { stdio: ['ignore', 'pipe', 'ignore'] });

sampler.stdout.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
        const n = parseInt(line.trim(), 10);
        if (Number.isFinite(n)) currentHandles = n;
    }
});

// Auf den ersten echten Messwert warten, sonst ist die Baseline -1.
await new Promise((res) => {
    const t = setInterval(() => { if (currentHandles > 0) { clearInterval(t); res(); } }, 100);
    setTimeout(() => { clearInterval(t); res(); }, 8000);
});

function handleCount() {
    return currentHandles;
}

const baseline = handleCount();
if (baseline <= 0) {
    console.error('FEHLER: kein Handle-Wert vom Sampler — Messung waere wertlos. Abbruch.');
    try { sampler.kill(); } catch { /* egal */ }
    process.exit(1);
}
console.log(`Baseline: ${baseline} Handles (vor Viewer-Start)\n`);

// --- Viewer starten ----------------------------------------------------------
let stopViewer = null;
if (!noViewer) {
    // Browser-Oeffnen unterdruecken: der Viewer ruft `cmd /c start` auf und
    // wuerde bei jedem Lauf ein Fenster aufmachen. Ein Monkey-Patch auf
    // child_process.spawn geht NICHT — ES-Module-Exports sind schreibgeschuetzt
    // ("Cannot assign to read only property"). Stattdessen den PATH leeren:
    // dann findet der spawn-Aufruf `cmd` nicht, scheitert still, und der Viewer
    // faengt das bereits ab (server.ts:105 try/catch). Der Rest laeuft normal —
    // node selbst braucht den PATH zur Laufzeit nicht mehr.
    const realPath = process.env.PATH;
    process.env.PATH = '';
    process.once('exit', () => { process.env.PATH = realPath; });

    const modUrl = pathToFileURL(join(import.meta.dirname, '..', 'build', 'viewer', 'server.js')).href;
    let mod;
    try {
        mod = await import(modUrl);
    } catch (err) {
        console.error(`\nFEHLER: build/viewer/server.js nicht ladbar — erst "npm run build" laufen lassen.`);
        console.error(err.message);
        process.exit(1);
    }

    console.log('Starte Viewer ...');
    const url = await mod.startViewer(projectPath);
    stopViewer = mod.stopViewer;
    console.log(`Viewer laeuft: ${url}\n`);
}

// --- Messschleife ------------------------------------------------------------
console.log('  t/s   Handles   Delta    RSS/MB');
let prev = baseline;
let peak = baseline;
const t0 = Date.now();

const timer = setInterval(() => {
    const elapsed = (Date.now() - t0) / 1000;
    const h = handleCount();
    const delta = h - prev;
    prev = h;
    if (h > peak) peak = h;

    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    appendFileSync(csvPath, `${label},${elapsed.toFixed(1)},${h},${delta},${dirs.total},${rss}\n`);

    const mark = delta > 50 ? ' <<<' : '';
    console.log(
        `${elapsed.toFixed(0).padStart(5)}   ${String(h).padStart(7)}   ${String(delta >= 0 ? '+' + delta : delta).padStart(5)}   ${String(rss).padStart(7)}${mark}`
    );

    if (elapsed >= seconds) finish();
}, intervalMs);

function finish() {
    clearInterval(timer);
    const growth = peak - baseline;
    const perDir = dirs.total > 0 ? (growth / dirs.total) : 0;

    console.log('\n--- Ergebnis ---');
    console.log(`  Projekt        : ${projectPath}`);
    console.log(`  Verzeichnisse  : ${dirs.total.toLocaleString('de-DE')}`);
    console.log(`  Baseline       : ${baseline} Handles`);
    console.log(`  Maximum        : ${peak} Handles`);
    console.log(`  Zuwachs        : ${growth > 0 ? '+' : ''}${growth} Handles`);
    console.log(`  Pro Verzeichnis: ${perDir.toFixed(2)}`);
    console.log(`  CSV            : ${csvPath}`);
    console.log('');
    console.log('  Deutung: liegt "pro Verzeichnis" nahe 1,0 und wiederholt sich das');
    console.log('  ueber verschieden grosse Projekte, ist es der chokidar-Watcher.');
    console.log('  Bleibt der Zuwachs projektunabhaengig gleich, ist es etwas anderes.');

    if (stopViewer) {
        try { stopViewer(); } catch { /* egal */ }
    }
    try { sampler.kill(); } catch { /* egal */ }
    process.exit(0);
}

process.on('SIGINT', finish);
