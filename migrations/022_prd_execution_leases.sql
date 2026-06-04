-- Add durable PRD execution leases for coding-system workflow ownership
-- Prevents multiple active runs for the same PRD in the same codebase and
-- preserves canonical source/execution identity across resume boundaries.

CREATE TABLE IF NOT EXISTS remote_agent_prd_execution_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  prd_id VARCHAR(255) NOT NULL,
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  workflow_name VARCHAR(255) NOT NULL,
  canonical_repo_path TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  execution_branch TEXT NOT NULL,
  working_path TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  released_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prd_execution_leases_active_unique
  ON remote_agent_prd_execution_leases(codebase_id, prd_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_prd_execution_leases_run_id
  ON remote_agent_prd_execution_leases(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_prd_execution_leases_status
  ON remote_agent_prd_execution_leases(status);
