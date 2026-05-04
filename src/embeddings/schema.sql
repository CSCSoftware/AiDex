-- ============================================================
-- AiDex Embeddings Schema
-- Lives in ~/.aidex/global.db, applied additively at first enable()
-- Vector storage uses sqlite-vec (vec0 virtual table) — see store.ts
-- ============================================================

-- ------------------------------------------------------------
-- Embedding entries metadata (joined with vec0 table by rowid)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embeddings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL,
    project_path  TEXT NOT NULL,
    source_type   TEXT NOT NULL CHECK(source_type IN (
        'method', 'type', 'doc-section', 'task', 'note', 'note-history', 'task-log'
    )),
    source_kind   TEXT NOT NULL CHECK(source_kind IN ('code', 'docs', 'workspace')),
    source_path   TEXT,            -- relative file path (NULL for workspace items)
    source_anchor TEXT,            -- e.g. "## Heading" or "task:#42"
    source_name   TEXT,            -- method/type name, task title, etc.
    source_line   INTEGER,         -- 1-based line number where applicable
    source_text   TEXT,            -- snippet for display (truncated to ~500 chars)
    content_hash  TEXT NOT NULL,   -- sha256 of input text — skip re-embedding when unchanged
    is_private    INTEGER NOT NULL DEFAULT 0,
    model_id      TEXT NOT NULL,   -- which model produced this vector
    dim           INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(source_kind);
CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(source_type);
CREATE INDEX IF NOT EXISTS idx_embeddings_path ON embeddings(project_path, source_path);
CREATE INDEX IF NOT EXISTS idx_embeddings_anchor ON embeddings(project_id, source_anchor);
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_unique
    ON embeddings(project_id, source_type, source_path, source_anchor);

-- vec0 virtual table is created lazily by store.ts once sqlite-vec is loaded.
-- Schema name: vec_embeddings
-- Layout: rowid (matches embeddings.id), embedding FLOAT[<dim>]
