-- Make codebase identity composite: (name, default_cwd).
-- Multiple local clones of the same remote now get distinct codebase_id values,
-- preventing conversations, sessions, env vars, and isolation environments from
-- leaking across clones.
--
-- Existing single-clone installs are unaffected — the unique index only
-- prevents future duplicate (name, path) pairs, and the application layer
-- handles name-only lookups for backward compatibility.
--
-- Pre-check for duplicates (run before applying if unsure):
--   SELECT name, default_cwd, COUNT(*) FROM remote_agent_codebases
--     GROUP BY name, default_cwd HAVING COUNT(*) > 1;
-- If duplicates exist, merge or delete the extra rows before running this migration.

CREATE UNIQUE INDEX IF NOT EXISTS idx_codebases_name_cwd
  ON remote_agent_codebases (name, default_cwd);
