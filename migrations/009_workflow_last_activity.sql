-- Migration: Add last_activity_at column for staleness detection
-- This enables activity-based staleness detection for stuck workflows

-- Add last_activity_at column
ALTER TABLE remote_agent_workflow_runs
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Backfill existing rows: use completed_at if available, otherwise started_at
UPDATE remote_agent_workflow_runs
SET last_activity_at = COALESCE(completed_at, started_at)
WHERE last_activity_at IS NULL;

-- Partial index for efficient staleness queries on running workflows
CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
ON remote_agent_workflow_runs(last_activity_at)
WHERE status = 'running';
