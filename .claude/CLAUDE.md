# AiDex - CLAUDE.md

MCP server for persistent code indexing (tree-sitter, SQLite) plus session notes, tasks, guidelines, screenshots,
LogHub and a browser viewer. npm package `aidex-mcp`, TypeScript, ESM. Public repo (MIT): keep everything English,
no personal data, names or private paths.

## Build, test, run

```bash
npm install && npm run build     # build = tsc + copy-assets (schema.sql files into build/)
npm test                         # jest (ESM, --experimental-vm-modules), tests/*.test.js
node build/index.js              # MCP server (stdio); CLI: scan <path>, init <path>
```

- Register the server under the name `aidex` so tools are prefixed `mcp__aidex__aidex_*`.
- After code changes: build, then reconnect/restart the MCP client - a running instance keeps the old code.
- Tool registration and schemas: `src/server/tools.ts`; implementations: `src/commands/`. Full API:
  `MCP-API-REFERENCE.md`; user docs: `README.md`; every release gets a `CHANGELOG.md` entry.

## Where things live

- Project index: `<project>/.aidex/` (SQLite, WAL; schema `src/db/schema.sql`). Global registry and global
  guidelines: `~/.aidex/global.db` (`src/db/global-schema.sql`); global queries ATTACH project DBs, no copying.
- **Guidelines (2.5.0):** project guidelines are metadata entries `guideline:<key>` in the project index, the
  `always` keys are the metadata entry `guidelines_always` (same scheme in global.db). No schema change.
  Logic: `src/commands/guidelines.ts` (project, session delivery, inheritance from indexed parent projects,
  outermost first, 6000-char budget warning) and `src/commands/global/global-guideline.ts`.
  `aidex_session` delivers all `always` texts under "Guidelines (binding)"; `action="binding"` returns that block read-only.
- **`aidex_health`** (`src/commands/health.ts`): read-only, deterministic report on loaded instructions
  (guidelines, global/project CLAUDE.md, AGENTS.md, CLAUDE.local.md, big session notes). Never writes.
- Session notes and other key-value state: `metadata` table; overwriting a note archives the old one.
- Ports: viewer 3333, global-init progress UI (SSE) 3334, LogHub 3335.

## Implementation gotchas

- Tree-sitter uses a 1 MB buffer for large files. Arrow functions are indexed as methods (intended).
- Line timestamps survive re-indexing when the line hash is unchanged (`modified_since` relies on it).
- Keyword filters per language: `src/parser/languages/`. `aidex_init` removes files that are now excluded.
- `aidex_screenshot` (security fix 2.4.1): never build shell/PowerShell strings from user input. Use
  `execFileSync` with argument arrays (macOS) and pass values to static PowerShell scripts via env vars
  (`AIDEX_SS_*`, `AIDEX_PP_*`). Keep the strict validation of `filename`/`save_path`/numeric args.

## LogHub dashboard (panel API)

- Widgets are keyed by `id`; resending the same `id` overwrites in place. `type` is required on first create;
  after `POST /panel/clear` (full reset) value-only updates to a removed id are ignored.
- `button` value is a monotonically increasing press counter counted by the hub (`/control/press`), not a flag.
  Any jump downwards (overflow at 1e6, clear, hub restart) means "restart, take the value", not a million presses.
- Control push (`src/loghub/control-push.ts`): fire and forget, 1.5 s timeout, one request in flight per
  subscriber, coalesced, subscription dropped after 3 failures; only http to loopback/private/link-local IPs,
  no DNS names, no redirects. Sources should keep polling `GET /control` slowly (~30 s) as a safety net.
  Test: `node scripts/test-control-push.mjs` (own hub on port 3399).
- Demo: `node scripts/demo-dashboard.mjs`. Never run two instances (they overwrite each other). Stopping a
  PowerShell wrapper does not kill the node child - start node directly and verify it is gone after stopping.
