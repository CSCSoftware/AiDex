# LogHub Panel-Dashboard — Anleitung

> **Status: GERÜST.** Texte mit `[AUSFORMULIEREN]`, Bilder mit `[BILD: …]`, Code mit
> `[BEISPIEL: …]` markiert. Single Source of Truth für die Feld-Referenz ist
> `src/loghub/panel-types.ts` (`PanelHttpEntry`). Quelle der HTTP-Endpunkte:
> `src/loghub/log-server.ts`.
>
> 🌐 **Generisch — keine Plattform vorausgesetzt.** Das Dashboard ist eine reine
> HTTP-Schnittstelle. Quelle kann **alles** sein, was POSTs senden kann: ein
> Python-Skript, eine C#-/WinForms-App, ein Node-Server, Shell + `curl`, der
> Browser, ein Mikrocontroller. Der Store weiß nichts über die Bedeutung der
> Werte. Wo unten ein ESP32 / der GeminiPod auftaucht, ist das **nur ein Beispiel**
> für eine Quelle — keine Voraussetzung. Bilder-Quelle ist zufällig das
> GeminiPod-Dashboard (ESP32 „Sophia"), weil es viele Widget-Typen gleichzeitig zeigt.
>
> ⚠️ **Beim Ausformulieren beachten — Gerüst war veraltet:** Der Code kennt
> inzwischen **zwei interaktive Widget-Typen** (`slider`, `number`) mit einem
> **Rückkanal** (`POST /control` / `GET /control`) und das Feld `step`. Diese
> Sektionen (3b, 4, 5) sind hier neu ergänzt und gegen den Code abgeglichen
> (Stand 2026-06-11). Alte Notizen, die nur 4 Typen kennen, sind überholt.

---

## 1. Was ist das Panel-Dashboard?

`[AUSFORMULIEREN]`
- Der Logs-Tab im Viewer hat **zwei Ansichten**: den scrollenden Log-Stream **und**
  das Panel-Dashboard.
- Panel = feste, per `id` adressierte Kacheln. Gleiche `id` erneut senden → Wert wird
  **in place überschrieben** (kein Wegscrollen). Gedacht für hochfrequente/wiederholte
  Werte: Audio-Pegel, Puffer-Füllstand, FPS, Heap, RSSI, Status-LEDs.
- **Zwei Richtungen:** Anzeige-Widgets (Quelle → AiDex) **und** interaktive Controls
  (`slider`/`number`), deren Wert der User im Viewer ändert und die zurück an die
  Quelle fließen (→ Sektion 3b). Grundprinzip durchgängig: **der Sender entscheidet,
  AiDex rendert nur.**
- Zero-cost wenn nicht genutzt. Empfänger ist HTTP — **keine Library nötig.**

`[BILD: Dashboard-Gesamtansicht mit allen Widget-Typen — GeminiPod]`

---

## 2. Schnellstart (3 Schritte)

`[AUSFORMULIEREN]`
1. **LogHub starten:** `aidex_log({ action: "init" })` → HTTP-Server auf Port **3335**.
2. **Viewer öffnen:** `aidex_viewer({ path: "." })` → Browser, Logs-Tab → Dashboard.
3. **Erstes Widget** definieren + Wert senden.

`[BEISPIEL: curl — ein label-Widget anlegen und einen Wert setzen]`
`[BILD: leeres Dashboard → erstes Widget erscheint]`

---

## 3. HTTP-API

### 3a. Anzeige-Endpunkte
`[AUSFORMULIEREN]`

| Methode & Pfad | Zweck |
|---|---|
| `POST /panel`   | Ein Widget (Definition **oder** Wert-Update — beides per upsert). |
| `POST /panels`  | Array von Widgets in einem Rutsch (Batch, effizient). |
| `POST /panel/clear` | Body `{}` = alle löschen, `{"id":"x"}` = eines. |
| `GET /health`   | Status-Check. |

- **Muster:** erst Definitionen (mit `type`/`group`/`label`/Skala) senden, dann laufend
  nur noch `{"id":…, "value":…}`-Updates. Upsert: `type` ist nur zum **Erstellen** nötig,
  Folge-Updates dürfen es weglassen.
- **Unbekannte JSON-Felder werden verworfen** — nur explizit unterstützte Felder
  (siehe Sektion 5) landen im Store. Kein stiller Fehler, aber auch kein Effekt.

### 3b. Control-Rückkanal (interaktive Widgets) — NEU
`[AUSFORMULIEREN]`

Für `slider`/`number`-Widgets fließt der vom User im Viewer geänderte Wert zurück an
die Quelle. Generisch und quell-agnostisch — der Store weiß nichts über die Bedeutung
des Werts.

| Methode & Pfad | Zweck |
|---|---|
| `POST /control` | Setzt einen Control-Wert. Body `{ id, value }`. Aktualisiert Store **und** die angezeigte Kachel (alle Viewer spiegeln die Änderung). Der Viewer ruft das auf, wenn der User schiebt/tippt. |
| `GET /control`  | Liefert den ganzen Store als flaches `{ id: value }`-Objekt. **Das pollt die Quelle**, um die aktuellen Set-Points zu lernen. Quelle = irgendein Programm (Skript, App, MCU …) — der Store ist quell-agnostisch. |

- **Fluss:** Quelle definiert ein `slider`-Widget → User schiebt im Viewer →
  `POST /control` → Quelle holt sich den neuen Wert per `GET /control` im eigenen Takt.
- Die „Quelle" ist hier dieselbe wie beim Senden der Anzeige-Werte — also ein
  beliebiges HTTP-fähiges Programm. (Im GeminiPod-Beispiel ist das der ESP32, aber
  genauso gut ein Python-Loop am PC.)
- `POST /control/clear` bzw. `POST /panel/clear` räumt Controls mit weg (Controls leben
  neben den Widgets).

`[BEISPIEL: slider definieren + GET /control pollen — Pseudocode]`
`[BILD: Slider im Viewer, Wert wird verschoben]`

---

## 4. Widget-Typen (`type`)

`[AUSFORMULIEREN]`

**Anzeige (Quelle → AiDex):**
- **`label`** — Text/Zahl als Wert. Mit `state` als farbige LED nutzbar.
- **`progress`** — horizontaler Balken, `min`..`max`, `warn`/`crit`-Schwellen → Farbzonen.
- **`gauge`** — Radial-Gauge (Afterburner-Style), `min`..`max`, `warn`/`crit`. Auch als
  LED-Feld: `state` = Farbe (`ok`/`warn`/`error`/…), `value` = freier Text.
- **`plot`** — Linien-Graph (HWiNFO/Afterburner-Style) mit History-Ring
  (`PLOT_HISTORY` = 200 Samples). Footer: cur/min/max/avg. Wert-Update: einzelne Zahl
  (an Ring anhängen) **oder** Array (ganzer Frame ersetzt die History).

**Interaktiv (User im Viewer → zurück an die Quelle, via Control-Store — NEU):**
- **`slider`** — Schieberegler. Felder: `min`/`max`/`step`/`value`/`label`/`group`/`order`.
- **`number`** — Zahlen-Eingabe. Gleiche Felder. Beide schreiben per `POST /control` zurück.

`[BILD: je ein Beispiel pro Typ nebeneinander — inkl. slider/number]`

---

## 5. Widget-Felder — vollständige Referenz

`[AUSFORMULIEREN: Einleitung]`
Abgeglichen gegen `PanelHttpEntry` in `src/loghub/panel-types.ts` (Stand 2026-06-11).

| Feld | Typ | Gilt für | Bedeutung |
|---|---|---|---|
| `id`      | string         | **alle (Pflicht)** | Eindeutiger Schlüssel. Gleiche id = Update in place. |
| `type`    | string         | **erstellen (Pflicht)** | `label`/`progress`/`gauge`/`plot`/`slider`/`number`. Nur beim Anlegen nötig. |
| `value`   | number\|string\|number[] | alle | Aktueller Wert. Bei `plot`: Zahl = anhängen, Array = ganzer Frame. |
| `group`   | string         | alle | Gruppen-Box. Viewer sortiert Gruppen **alphabetisch** → Zahlen-Präfix (`"1 Boot"`, `"2 Audio"`) erzwingt Reihenfolge. |
| `label`   | string         | alle | Anzeigename der Kachel. |
| `unit`    | string         | alle | Einheit (z.B. `dB`, `%`, `ms`). |
| `min`     | number         | progress/gauge/plot/slider/number | Skala/Range-Untergrenze. |
| `max`     | number         | progress/gauge/plot/slider/number | Skala/Range-Obergrenze. |
| `step`    | number         | **slider/number** | Schrittweite pro Tick (default 1). |
| `warn`    | number         | gauge/progress | Schwelle → gelbe Zone. |
| `crit`    | number         | gauge/progress | Schwelle → rote Zone. |
| `color`   | string         | alle | Accent-Name (`cyan`/`green`/`orange`/`purple`/…) oder Hex. |
| `order`   | number         | alle | Sortierung innerhalb der Gruppe. |
| `state`   | string         | gauge/label | **LED-Farbe getrennt vom `value`-Text** (`ok`/`warn`/`error`/…). Farbige LED + lesbarer Text gleichzeitig. |
| `scale`   | string         | **plot** | Y-Achse: `"linear"` (default) \| `"log"`. → Sektion 6. |
| `decimals`| number         | **plot** | Nachkommastellen im Footer (0 = ganzzahlig). |
| `autoMin` | boolean        | **plot** | Untergrenze folgt dem Daten-Minimum (Decke bleibt `max`). → Sektion 6. |

> Hinweis: `step`, `scale`, `decimals`, `autoMin` sind alle **sender-gesteuert** —
> der Renderer rendert nur, was ankommt.

---

## 6. Plot-Skalierung im Detail (Kern-Learning vom 03.06.)

`[AUSFORMULIEREN]`
- **Autoskala (default):** ohne festes `min`/`max` skaliert der Plot auf die History
  (+10 % Padding). Problem: ein einzelner Riesen-Peak drückt die ganze Kurve platt.
- **Feste Skala:** `min`+`max` setzen → kein Zappeln bei kleinen Schwankungen; Werte
  außerhalb werden geclamped (kein Ausreißer aus dem Canvas).
- **Log-Skala (`scale:"log"`):** für große Dynamik (Audio, dB-artig). Grenzen werden
  auf ≥ 1 gehoben.
- **`autoMin`:** gegen das „tote Drittel" unter dem Grundrauschen — der Untergrund
  klebt unten, volle Plot-Höhe fürs Signal.
- **Empfehlung Audio-Pegel:** `scale:"log"` + `autoMin:true` + `max`=Vollausschlag +
  `decimals:0`.

`[BILD: Vorher/Nachher — linear-Autoskala (Peak erschlägt alles) vs log+autoMin
(Rauschen unten, Signal sichtbar)]`

---

## 7. Footer (cur/min/max/avg)

`[AUSFORMULIEREN]`
- Vertikal gestapelt (untereinander) → voll lesbar, kein Abschneiden.
- `decimals` steuert die Nachkommastellen.

---

## 8. Best Practices / Stolpersteine (aus echtem Einsatz)

`[AUSFORMULIEREN — Stichpunkte stehen, in Fließtext/Tipps gießen]`
- **Definitionen vor Live-Werten:** erst `/panels` mit allen Defs, dann Updates.
- **Batch nutzen (`/panels`):** EIN POST pro Dashboard-Tick statt vieler einzelner.
- **Senden vom Echtzeit-Pfad entkoppeln:** HTTP-POSTs blockieren. Aus zeitkritischen
  Schleifen (Audio-Callback, Render-Loop, ISR) NICHT direkt senden — stattdessen ein
  eigener Dashboard-Task/Thread mit fester Rate (z.B. 5–10 Hz). Gilt überall, ist auf
  ressourcenarmen Quellen (z.B. einem MCU) nur besonders spürbar.
- **Peak-Hold für kurze Events:** wenn der Sende-Takt langsamer ist als das Ereignis,
  das MAX seit dem letzten Tick senden (Reset beim Auslesen), sonst verschluckt der
  Plot kurze Peaks zwischen zwei Ticks.
- **Gruppen-Reihenfolge** über Zahlen-Präfix im `group`-Namen erzwingen.
- **Dynamische Skala vom Sender:** Gesamtwerte, die erst zur Laufzeit bekannt sind
  (z.B. Gesamt-Heap), in die Definition rechnen + in den Titel („Heap frei (von N)").
- **Anlaufverzögerung:** bei Plots mit Auto-History die ersten ein bis zwei Sekunden
  Einschwing-Werte überspringen, sonst dominiert ein Boot-Peak die History.
- **`state` vs `value`:** für farbige Status-LEDs `state` (Farbe) und `value` (Text) trennen.
- **Controls entkoppeln:** `GET /control` im eigenen Takt pollen, nicht synchron zum
  Senden — der Set-Point ändert sich selten, das Polling darf langsam sein.

---

## 9. Vollständiges Beispiel

`[BEISPIEL: kommentiertes End-to-End-Audio-Pegel-Dashboard]`
- Definitions-Batch (`POST /panels`) mit allen Widgets inkl. einem `slider` zum
  Live-Tuning eines Schwellwerts.
- Zyklische Updates (`POST /panels` pro Tick).
- `GET /control`-Poll, um den Slider-Wert zu übernehmen.
- Sprach-agnostisch (reines HTTP, Pseudocode/curl).

`[BILD: das fertige laufende Dashboard]`

---

## 10. Screenshots erstellen — GeminiPod als Demo-Objekt

`[AUSFORMULIEREN / DURCHFÜHREN]`
- **Bild-Quelle = GeminiPod-Dashboard** (ESP32 „Sophia"). Zeigt alle Widget-Typen in
  einem realen System: Plots (Mic Peak, Speaker, Heap), Progress (Mic RMS, Spk Ring,
  PSRAM), Gauge (RSSI, Heartbeat), Status-LEDs (Wake Active/Detections/Last), Labels
  (Modus, Uptime, Task-Stacks). `[+ falls vorhanden: slider/number-Controls zeigen]`
- **ERST wenn GeminiPod feature-vollständig** und alle Felder leben — insbesondere
  Speaker-Plot **und** Spk-Ring müssen im Normalbetrieb echte Werte zeigen (nicht nur
  kurz bei der „Ja"-Quittung). Also erst nach laufender Gemini-Live-Session mit
  dauerhaftem Streaming-TTS in den Speaker. Vorher wären Speaker-Plot/Ring meist 0.
- **Reihenfolge fürs Bebildern:** (1) GeminiPod fertig (Live-Session + Speaker dauernd
  aktiv), (2) während echter Konversation Region-Screenshots ziehen, (3) Vorher/Nachher-
  Paar der Skalen-Sektion gezielt nachstellen (einmal ohne `scale`/`autoMin`, einmal mit).
- **Capture-Tool:** `aidex_screenshot({ mode: "region" })`.

---

## TODO (Uwe macht in AiDex fertig)
- [ ] Texte ausformulieren (`[AUSFORMULIEREN]`-Marker)
- [ ] curl/HTTP-Beispiele konkretisieren (`[BEISPIEL]`-Marker)
- [ ] Screenshots einfügen (`[BILD]`-Marker) — Quelle GeminiPod, ERST wenn
      feature-vollständig (Speaker-Plot + Spk-Ring zeigen dauerhaft Werte)
- [ ] `slider`/`number` + Control-Rückkanal: prüfen, ob im aktuellen GeminiPod-Build
      schon genutzt → ggf. in Demo-Bild aufnehmen
- [ ] Verlinken: in AiDex-`CLAUDE.md` „LogHub Developer Guide" + ggf. Guideline
- [ ] Feld-Referenztabelle final gegen `panel-types.ts` halten (Single Source of Truth)
