-- =====================================================
-- Add Agent Work Orders Repository Management
-- =====================================================
-- This migration adds support for repository-based agent work order management.
--
-- Features:
-- - GitHub repository registration and management
-- - Work order status tracking (high-level only)
-- - Repository-scoped work order organization
-- - Integration with agent work orders microservice
--
-- Architecture:
-- - Archon/Supabase: Management layer (repositories, work order status)
-- - Agent Service: Execution layer (in-memory step details, logs, git stats)
-- =====================================================

-- GitHub Repositories for Agent Work Orders
CREATE TABLE IF NOT EXISTS agent_work_order_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_url TEXT NOT NULL UNIQUE,
  repository_name TEXT NOT NULL,  -- Extracted: "owner/repo"
  repository_owner TEXT NOT NULL,  -- Extracted: "owner"
  repository_display_name TEXT,  -- Optional custom name
  pinned BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,  -- For future: GitHub API data (stars, language, description)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Work Orders Status Tracking
-- Stores high-level status only; execution details remain in agent service
CREATE TABLE IF NOT EXISTS agent_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_work_order_id TEXT NOT NULL UNIQUE,  -- Human-readable ID (wo-xxxxx)
  repository_id UUID NOT NULL REFERENCES agent_work_order_repositories(id) ON DELETE CASCADE,

  -- User inputs (for display/context)
  user_request TEXT NOT NULL,
  selected_commands JSONB DEFAULT '[]'::jsonb,  -- Workflow steps chosen
  sandbox_type TEXT DEFAULT 'git_worktree',
  github_issue_number TEXT,

  -- Kanban status (UI-controlled)
  status TEXT DEFAULT 'todo',  -- todo, in_progress, review, done
  current_phase TEXT,  -- Agent execution phase: planning, executing, committing

  -- Results (populated on completion)
  git_branch_name TEXT,
  github_pull_request_url TEXT,
  error_message TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_awo_repos_url ON agent_work_order_repositories(repository_url);
CREATE INDEX IF NOT EXISTS idx_awo_repos_owner ON agent_work_order_repositories(repository_owner);
CREATE INDEX IF NOT EXISTS idx_awo_repos_pinned ON agent_work_order_repositories(pinned DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_awo_work_order_id ON agent_work_orders(agent_work_order_id);
CREATE INDEX IF NOT EXISTS idx_awo_repository_id ON agent_work_orders(repository_id);
CREATE INDEX IF NOT EXISTS idx_awo_status ON agent_work_orders(status);
CREATE INDEX IF NOT EXISTS idx_awo_repo_status ON agent_work_orders(repository_id, status);
CREATE INDEX IF NOT EXISTS idx_awo_created ON agent_work_orders(created_at DESC);

-- Triggers for updated_at
CREATE TRIGGER update_agent_work_order_repos_updated_at
  BEFORE UPDATE ON agent_work_order_repositories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_work_orders_updated_at
  BEFORE UPDATE ON agent_work_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE agent_work_order_repositories IS 'GitHub repositories configured for agent work orders';
COMMENT ON TABLE agent_work_orders IS 'High-level work order status tracking (detailed execution in agent service)';
COMMENT ON COLUMN agent_work_orders.user_request IS 'User description of the work to be done';
COMMENT ON COLUMN agent_work_orders.selected_commands IS 'Workflow steps chosen: ["create-branch", "planning", "execute", "commit", "create-pr"]';
COMMENT ON COLUMN agent_work_orders.status IS 'Kanban column status: todo, in_progress, review, done';
COMMENT ON COLUMN agent_work_orders.current_phase IS 'Agent execution phase (when in_progress): planning, executing, committing';

-- Enable Row Level Security (RLS)
ALTER TABLE agent_work_order_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_work_orders ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (makes this idempotent)
DROP POLICY IF EXISTS "Allow service role full access to agent_work_order_repositories" ON agent_work_order_repositories;
DROP POLICY IF EXISTS "Allow service role full access to agent_work_orders" ON agent_work_orders;
DROP POLICY IF EXISTS "Allow authenticated users to read and update agent_work_order_repositories" ON agent_work_order_repositories;
DROP POLICY IF EXISTS "Allow authenticated users to read and update agent_work_orders" ON agent_work_orders;

-- Create RLS policies for service role (full access)
CREATE POLICY "Allow service role full access to agent_work_order_repositories" ON agent_work_order_repositories
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to agent_work_orders" ON agent_work_orders
    FOR ALL USING (auth.role() = 'service_role');

-- Create RLS policies for authenticated users (read and update)
CREATE POLICY "Allow authenticated users to read and update agent_work_order_repositories" ON agent_work_order_repositories
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read and update agent_work_orders" ON agent_work_orders
    FOR ALL TO authenticated
    USING (true);

-- Record migration application for tracking
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '012_add_agent_work_orders_repositories')
ON CONFLICT (version, migration_name) DO NOTHING;

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
