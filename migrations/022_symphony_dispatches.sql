-- 022_symphony_dispatches.sql
-- Joins Symphony tracker issues to Archon workflow runs.
-- Version: 22.0
-- Description: One row per (tracker, issue) dispatch attempt. The orchestrator
--   keys its in-memory state by `dispatch_key` (e.g. "linear:<issue_id>" or
--   "github:<owner>/<repo>#<number>") so the same raw issue id from two trackers
--   does not collide. `workflow_run_id` is null until the dispatcher pre-creates
--   or launches the Archon workflow run; on terminal status the orchestrator
--   updates `status` (running | completed | failed | cancelled) and (on failure)
--   `last_error`.

CREATE TABLE IF NOT EXISTS symphony_dispatches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id        TEXT NOT NULL,
  identifier      TEXT NOT NULL,
  tracker         TEXT NOT NULL CHECK (tracker IN ('linear', 'github')),
  dispatch_key    TEXT NOT NULL UNIQUE,
  codebase_id     UUID NULL REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  workflow_name   TEXT NOT NULL,
  workflow_run_id UUID NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  attempt         INTEGER NOT NULL,
  dispatched_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status          TEXT NOT NULL,
  last_error      TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_symphony_dispatches_tracker_issue
  ON symphony_dispatches (tracker, issue_id);
CREATE INDEX IF NOT EXISTS idx_symphony_dispatches_identifier
  ON symphony_dispatches (identifier);
CREATE INDEX IF NOT EXISTS idx_symphony_dispatches_workflow_run
  ON symphony_dispatches (workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_symphony_dispatches_codebase
  ON symphony_dispatches (codebase_id);

COMMENT ON TABLE symphony_dispatches IS
  'Symphony tracker-issue → Archon workflow-run join. One row per dispatch attempt; keyed by dispatch_key for source-aware uniqueness.';
