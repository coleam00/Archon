-- Mission Control replay support
-- Adds replay_of_run_id FK to track replays of historical runs.

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS replay_of_run_id UUID
    REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_replay_of
  ON remote_agent_workflow_runs(replay_of_run_id);

-- Composite indexes used by Mission Control history (cursor pagination by
-- (started_at desc, id desc) and per-codebase scoped queries).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_started_id
  ON remote_agent_workflow_runs(status, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_codebase_started
  ON remote_agent_workflow_runs(codebase_id, started_at DESC);
