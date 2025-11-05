-- =====================================================
-- Agent Work Orders - Complete Setup
-- =====================================================
-- This migration creates all tables needed for the Agent Work Orders
-- automation feature, which applies Context Hub templates to repositories
-- with repository-specific customizations.
--
-- PREREQUISITE: Context Hub tables must exist (run complete_setup.sql first)
--
-- This consolidates the old agent_work_orders_repositories.sql and
-- agent_work_orders_state.sql migrations plus new template integration.
--
-- Tables created:
-- - archon_configured_repositories (repositories using AWO)
-- - archon_repository_agent_overrides (agent tool/standard overrides per repo)
-- - archon_agent_work_orders (work orders with selected steps)
-- - archon_agent_work_order_steps (execution history)
--
-- This is an OPTIONAL feature - only run if you want AWO automation.
-- =====================================================

BEGIN;

-- Create archon_configured_repositories table
CREATE TABLE IF NOT EXISTS archon_configured_repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_url TEXT NOT NULL UNIQUE,
    display_name TEXT,
    owner TEXT,
    default_branch TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    last_verified_at TIMESTAMPTZ,
    workflow_template_id UUID REFERENCES archon_workflow_templates(id) ON DELETE SET NULL,
    coding_standard_ids UUID[] DEFAULT '{}',
    priming_context JSONB DEFAULT '{}',
    use_template_execution BOOLEAN DEFAULT FALSE,
    default_sandbox_type TEXT DEFAULT 'git_worktree'
        CHECK (default_sandbox_type IN ('git_worktree', 'full_clone', 'tmp_dir')),
    default_commands JSONB DEFAULT '["create-branch", "planning", "execute", "commit", "create-pr"]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_repository_url CHECK (
        repository_url ~ '^https://github\.com/[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+/?$'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_configured_repositories_url
    ON archon_configured_repositories(repository_url);
CREATE INDEX IF NOT EXISTS idx_configured_repositories_verified
    ON archon_configured_repositories(is_verified);
CREATE INDEX IF NOT EXISTS idx_configured_repositories_created_at
    ON archon_configured_repositories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_configured_repositories_workflow
    ON archon_configured_repositories(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_configured_repositories_commands
    ON archon_configured_repositories USING GIN(default_commands);

CREATE TRIGGER update_configured_repositories_updated_at
    BEFORE UPDATE ON archon_configured_repositories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE archon_configured_repositories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access to archon_configured_repositories"
    ON archon_configured_repositories
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read and update archon_configured_repositories"
    ON archon_configured_repositories
    FOR ALL
    TO authenticated
    USING (true);

COMMENT ON TABLE archon_configured_repositories IS 'Repositories using Agent Work Orders automation';
COMMENT ON COLUMN archon_configured_repositories.workflow_template_id IS 'Default workflow template (links to Context Hub)';
COMMENT ON COLUMN archon_configured_repositories.coding_standard_ids IS 'Array of coding standard UUIDs';
COMMENT ON COLUMN archon_configured_repositories.priming_context IS 'Repository-specific context: paths, architecture (JSONB)';
COMMENT ON COLUMN archon_configured_repositories.use_template_execution IS 'Flag: true=templates, false=hardcoded .md files';

-- Create archon_repository_agent_overrides table
CREATE TABLE IF NOT EXISTS archon_repository_agent_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES archon_configured_repositories(id) ON DELETE CASCADE,
    agent_template_id UUID NOT NULL REFERENCES archon_agent_templates(id) ON DELETE CASCADE,
    override_tools JSONB,
    override_standards JSONB,
    role TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_repo_agent_override UNIQUE (repository_id, agent_template_id)
);

CREATE INDEX IF NOT EXISTS idx_repo_agent_overrides_repo ON archon_repository_agent_overrides(repository_id);
CREATE INDEX IF NOT EXISTS idx_repo_agent_overrides_agent ON archon_repository_agent_overrides(agent_template_id);
CREATE INDEX IF NOT EXISTS idx_repo_agent_overrides_role ON archon_repository_agent_overrides(role);

CREATE TRIGGER update_repo_agent_overrides_updated_at
    BEFORE UPDATE ON archon_repository_agent_overrides
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE archon_repository_agent_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access to archon_repository_agent_overrides"
    ON archon_repository_agent_overrides
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read and update archon_repository_agent_overrides"
    ON archon_repository_agent_overrides
    FOR ALL
    TO authenticated
    USING (true);

COMMENT ON TABLE archon_repository_agent_overrides IS 'Repository-specific agent tool and standard overrides';
COMMENT ON COLUMN archon_repository_agent_overrides.override_tools IS 'Tools override (NULL = use template default)';
COMMENT ON COLUMN archon_repository_agent_overrides.override_standards IS 'Standards override (NULL = use template default)';

-- Create archon_agent_work_orders table
CREATE TABLE IF NOT EXISTS archon_agent_work_orders (
    agent_work_order_id TEXT PRIMARY KEY,
    repository_url TEXT NOT NULL,
    sandbox_identifier TEXT NOT NULL,
    git_branch_name TEXT,
    agent_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    metadata JSONB DEFAULT '{}'::jsonb,
    selected_steps JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_work_orders_status
    ON archon_agent_work_orders(status);
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_created_at
    ON archon_agent_work_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_repository
    ON archon_agent_work_orders(repository_url);
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_metadata
    ON archon_agent_work_orders USING GIN(metadata);

CREATE TRIGGER update_agent_work_orders_updated_at
    BEFORE UPDATE ON archon_agent_work_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE archon_agent_work_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access to archon_agent_work_orders"
    ON archon_agent_work_orders
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read and update archon_agent_work_orders"
    ON archon_agent_work_orders
    FOR ALL
    TO authenticated
    USING (true);

COMMENT ON TABLE archon_agent_work_orders IS 'Agent work orders with state and metadata (ACID guarantees)';
COMMENT ON COLUMN archon_agent_work_orders.agent_work_order_id IS 'Unique work order ID (TEXT format from id_generator.py)';
COMMENT ON COLUMN archon_agent_work_orders.status IS 'Current status: pending, running, completed, or failed';
COMMENT ON COLUMN archon_agent_work_orders.metadata IS 'JSONB metadata: sandbox_type, github_issue_number, current_phase, error_message, etc.';
COMMENT ON COLUMN archon_agent_work_orders.selected_steps IS 'Array of steps to execute (user can toggle on/off)';

-- Create archon_agent_work_order_steps table
CREATE TABLE IF NOT EXISTS archon_agent_work_order_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_work_order_id TEXT NOT NULL REFERENCES archon_agent_work_orders(agent_work_order_id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    output TEXT,
    error_message TEXT,
    duration_seconds FLOAT NOT NULL,
    session_id TEXT,
    executed_at TIMESTAMPTZ NOT NULL,
    step_order INT NOT NULL,
    sub_step_results JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_agent_work_order_steps_work_order_id
    ON archon_agent_work_order_steps(agent_work_order_id);
CREATE INDEX IF NOT EXISTS idx_agent_work_order_steps_executed_at
    ON archon_agent_work_order_steps(executed_at);

ALTER TABLE archon_agent_work_order_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access to archon_agent_work_order_steps"
    ON archon_agent_work_order_steps
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read and update archon_agent_work_order_steps"
    ON archon_agent_work_order_steps
    FOR ALL
    TO authenticated
    USING (true);

COMMENT ON TABLE archon_agent_work_order_steps IS 'Step execution history for work orders with foreign key constraints';
COMMENT ON COLUMN archon_agent_work_order_steps.agent_work_order_id IS 'Foreign key to work order (CASCADE delete)';
COMMENT ON COLUMN archon_agent_work_order_steps.step IS 'WorkflowStep enum value (e.g., "planning", "execute")';
COMMENT ON COLUMN archon_agent_work_order_steps.sub_step_results IS 'Results from sub-workflow execution';

COMMIT;
