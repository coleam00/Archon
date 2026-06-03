-- Add default_branch to codebases (preserved from SQLite source for migration parity)
-- SQLite createSchema() has had this column since 0.4.0; Postgres never added it.
-- All 4 live SQLite rows are 'main' (verified). Adding here so the migration script
-- can copy all columns without data loss.
-- DEFAULT 'main' matches SQLite's existing default.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch TEXT DEFAULT 'main';
