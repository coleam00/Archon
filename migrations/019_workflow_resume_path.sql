-- Add working_path to workflow_runs for resume detection
-- Version: 19.0
-- Description: Stores the cwd (worktree path) for each workflow run so
--   re-runs on the same branch can find prior failed runs and resume.

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS working_path TEXT;
