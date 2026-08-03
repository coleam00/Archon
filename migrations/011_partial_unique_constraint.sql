-- Fix: Replace full unique constraint with partial unique index
-- Only active environments need uniqueness enforcement
-- Destroyed environments should not block re-creation
-- Version: 11.0
-- Fixes: #239

-- Drop the existing full constraint
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

-- Create partial unique index (only applies to active records)
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
