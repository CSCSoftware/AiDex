# Demo-GIF Script — AiDex 2.0

Goal: 30-60 second loop showing what AiDex does that grep can't.
Format: silent GIF (or MP4 + ASCIINEMA fallback). Reusable for README, Reddit, dev.to.

---

## Recording Setup

**Tool:** ScreenToGif (Windows, free, https://www.screentogif.com/) or OBS + ffmpeg + gifski.

**Screen size:** 1280×720 (downscale to 800×450 for GIF if file size > 4 MB).

**Frame rate:** 15 fps for GIF (good readability/size tradeoff). 30 fps if MP4.

**Terminal:** Windows Terminal with a clean theme (black bg, white text). Font: Cascadia Code 14pt minimum — must stay readable after compression.

**What to hide before recording:**
- Other windows / desktop icons
- Anything personal in the prompt (rename `UweChalas` → `dev` if visible)
- Git branch indicators (use a clean directory)

---

## Demo 1 — "Find Concepts, Not Just Names" (the v2.0 hero shot)

**Total length:** 35-40 seconds.

**Audience message:** AiDex 2.0 finds code by *what it means*, not just by name. This is the v2.0 differentiator.

### Storyboard

| Time | Action | Text on screen | Why this beat |
|------|--------|----------------|---------------|
| 0-3s | Title card (static frame, fade-in) | `AiDex 2.0 — Semantic search for your AI` | Anchor the brand |
| 3-7s | Type into terminal | `grep -r "cache the model" .` | Set up the failure case |
| 7-10s | Hit enter, results scroll | (empty / no useful matches — pick a term where grep returns nothing or noise) | Show grep blind spot |
| 10-12s | Cut to second pane | `aidex_search "how do we cache the embedding model"` | Same intent, natural language |
| 12-16s | Results appear | Shows: `getQueryEmbedder` in `embeddings/pipeline.ts:312` with snippet | The "aha" moment |
| 16-20s | Highlight: distance score, file:line, snippet | (zoom on one result card) | Trust signal — exact location |
| 20-28s | Second query: German | `aidex_search "wie speichern wir den index lokal"` | Show LLM-translation |
| 28-32s | Result: SQLite database setup code | (English code found from German query) | Multilingual proof |
| 32-38s | End card | `aidex-mcp@2.0.0 — npm install -g aidex-mcp` `+ "Local-first. Privacy by default."` | Clear CTA |

### Exact commands to type during the recording

```bash
# Pane 1 — set up
clear
cd Q:/develop/Repos/Aidex

# Beat 1: grep failure
grep -rn "cache the model" src/ --include="*.ts"
# (expect: silence or one irrelevant comment)

# Beat 2: AiDex semantic
# (this is run via MCP tool; for a CLI demo, use a small wrapper script
# or fake it by capturing the JSON output and pretty-printing)
```

**Important:** AiDex search runs through MCP, not a CLI. For the GIF, two options:
1. **Recommended:** Record the **Viewer Search tab** — open `aidex_settings({ open: true })`, switch to Search tab, type the query live. The results stream in via WebSocket — visually compelling.
2. Fallback: Build a tiny `node demo-search.js "query"` wrapper that calls `getEmbeddings().search()` directly and prints results. Looks like a normal CLI.

### Frames to keep readable after GIF compression
- The query text (typing it in)
- The first 1-2 result cards (filename + snippet)
- The end card (npm install line)

Everything else is "atmosphere" — let it blur if it has to.

---

## Demo 2 — "grep vs AiDex" (the original token-savings story)

**Total length:** 25-30 seconds. Use as second GIF for token-focused channels (HN, r/coding).

### Storyboard

| Time | Action | Text on screen |
|------|--------|----------------|
| 0-3s | Split-pane terminal: left = grep, right = AiDex | (titles: "grep" / "aidex_query") |
| 3-7s | Both type same query: `PlayerHealth` | (synchronized typing if possible) |
| 7-12s | Left: 200+ matches scroll past, eat the screen | (chaos) |
| 7-12s | Right: 3 lines, clean | (calm) |
| 12-18s | Token-cost overlay appears | "grep: ~2,000 tokens · AiDex: ~50 tokens" |
| 18-25s | End card | `40× less context. 1 tool call. aidex-mcp@2.0.0` |

### Exact commands

```bash
# Left pane
grep -rn "PlayerHealth" .

# Right pane (real or wrapped)
aidex_query({ term: "PlayerHealth" })
# Expected output: 3 hits with file:line
```

**You'll need a small fake project for this** — AiDex itself doesn't have `PlayerHealth`. Either:
- Record against a game project you have (TaaviBook?)
- Or use a real AiDex term, e.g. `getEmbeddings` — grep finds it ~80 times across all files; aidex_query returns 1 definition + 5 references. Same story.

---

## Demo 3 — "Cross-project search" (optional, for power-user channels)

**Total length:** 20-25 seconds.

| Time | Action | Text |
|------|--------|------|
| 0-5s | Terminal showing folder tree of 5+ projects | "Q:/develop/Repos/ — 47 projects" |
| 5-12s | Run `aidex_global_query({ term: "TransparentWindow", mode: "contains" })` | |
| 12-18s | Results: hits across 4 different projects | (badges with project names) |
| 18-25s | End card | "One query. Every repo. Indexed once." |

---

## Recommended publishing order

1. **Demo 1** (semantic search) → goes into README hero, dev.to article, r/ClaudeAI post
2. **Demo 2** (grep vs AiDex) → r/coding, r/programming, HN
3. **Demo 3** (cross-project) → r/LocalLLaMA, dev.to follow-up

**File names** (suggested):
- `docs/aidex-demo-semantic.gif`
- `docs/aidex-demo-grep-vs-aidex.gif` (or replace existing `aidex-demo.gif`)
- `docs/aidex-demo-crossproject.gif`

---

## Compression target

GIF: ≤ 4 MB so README renders inline on mobile / GitHub.
MP4 fallback: ≤ 2 MB at 30 fps.

```bash
# After ScreenToGif export, re-compress with gifsicle:
gifsicle -O3 --lossy=80 input.gif -o output.gif

# Or: convert MP4 to GIF with ffmpeg + gifski for best quality:
ffmpeg -i raw.mp4 -vf "fps=15,scale=800:-1" -f image2pipe -vcodec ppm - | gifski -o demo.gif --width 800 -
```

---

## Asciinema fallback

If GIF recording is too fiddly: record terminal sessions with [asciinema](https://asciinema.org/) and embed the SVG/cast files in dev.to and the GitHub README. Tradeoff: no GUI Viewer demo possible (terminal only), but the file size is tiny and the text stays sharp.

```bash
asciinema rec aidex-search.cast
# ... do the demo
# Ctrl+D to stop
asciinema upload aidex-search.cast
# Or render to SVG: agg aidex-search.cast aidex-search.svg
```
