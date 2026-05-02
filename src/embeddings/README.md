# AiDex Embeddings (`src/embeddings/`)

Encapsulated semantic-search subsystem. The rest of AiDex talks to this module
**only** through `getEmbeddings()` — no deep imports.

## Module layout

```
src/embeddings/
├── index.ts             Public API + lazy-loading stub (this is the only file outside callers should import)
├── pipeline.ts          Real implementation, instantiated on first enable()
├── store.ts             SQLite work: schema migration, project enable/disable
├── embedder.ts          Model wrapper (Transformers.js) — v1.19c+
├── model-registry.ts    Known models (jina-code, nomic-text, bge-small)
├── chunker.ts           Code → embedding text (Tier A signature + Tier B doc + Tier C identifier bag)
├── chunker-docs.ts      Markdown section chunker — v1.21
├── chunker-workspace.ts Task/note chunker — v1.20
├── search.ts            vec0 KNN with filters + RRF hybrid — v1.22
├── triggers.ts          Incremental update hooks — v1.23
├── migration.ts         Model-switch re-indexing — v1.23
└── schema.sql           `embeddings` table + projects.embedding_* columns
```

## Public API

```ts
import { getEmbeddings } from './embeddings/index.js';

const e = getEmbeddings();
e.isEnabled(projectPath);                       // false until enable() runs
await e.enable(projectPath, { model: 'jina-code' });
await e.indexProject(projectPath);
await e.search({ query: 'retry with backoff', scope: 'all', k: 20 });
```

The default singleton is a **stub**. Calling `enable()` swaps in the real
implementation via dynamic `import('./pipeline.js')` so heavy dependencies
(@xenova/transformers, sqlite-vec) only load when actually used.

## Storage

Embeddings live in `~/.aidex/global.db` alongside existing project metadata.
A single shared table — filtering by `project_id` / `project_path` covers both
local and cross-project queries.

Schema additions are applied on first `enable()`:

- New table `embeddings` (metadata + content_hash for skip-on-no-change).
- New columns on `projects`: `embedding_model_id`, `embedding_dim`,
  `embedding_version`, `last_full_embed_at`, `files_changed_since`.

The vec0 virtual table for vectors is created lazily by `store.ts` once
`sqlite-vec` is loaded (v1.19c).

## Optional dependencies

Embeddings rely on packages that are **not** required to use AiDex:

- `@xenova/transformers` — ONNX runtime for Transformers.js (~50 MB)
- `sqlite-vec` — SQLite vector extension (~5 MB)

Both are declared as `optionalDependencies` in `package.json`. Install failures
do not break AiDex; the stub remains active.

## Roadmap

| Version | Scope                                                       |
|---------|-------------------------------------------------------------|
| v1.19a  | Method bodies in DB (prerequisite, shipped)                 |
| v1.19b  | Module skeleton + schema + lazy load (this version)         |
| v1.19c  | Code embeddings via three-tier chunking + Jina model        |
| v1.20   | Workspace embeddings (tasks, notes, history)                |
| v1.21   | Markdown / docs embeddings                                  |
| v1.22   | `aidex_search` MCP tool with scope, source_kinds, hybrid    |
| v1.23   | Incremental updates + model-migration detection             |
| v1.24   | Viewer "Search" tab                                         |
