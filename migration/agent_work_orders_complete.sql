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

-- =====================================================
-- STEP 1: Create archon_configured_repositories table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_configured_repositories (
    -- Primary identification
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Repository identification
    repository_url TEXT NOT NULL UNIQUE,
    display_name TEXT,
    owner TEXT,
    default_branch TEXT,

    -- Verification status
    is_verified BOOLEAN DEFAULT FALSE,
    last_verified_at TIMESTAMPTZ,

    -- Template links (NEW - links to Context Hub)
    workflow_template_id UUID REFERENCES archon_workflow_templates(id) ON DELETE SET NULL,
    coding_standard_ids UUID[] DEFAULT '{}',

    -- Repository-specific customizations (NEW)
    priming_context JSONB DEFAULT '{}',
    use_template_execution BOOLEAN DEFAULT FALSE,

    -- Per-repository preferences (EXISTING)
    default_sandbox_type TEXT DEFAULT 'git_worktree'
        CHECK (default_sandbox_type IN ('git_worktree', 'full_clone', 'tmp_dir')),
    default_commands JSONB DEFAULT '["create-branch", "planning", "execute", "commit", "create-pr"]'::jsonb,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- URL validation constraint
    CONSTRAINT valid_repository_url CHECK (
        repository_url ~ '^https://github\.com/[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+/?$'
    )
);

-- Indexes
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

-- Trigger
CREATE TRIGGER update_configured_repositories_updated_at
    BEFORE UPDATE ON archon_configured_repositories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security
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

-- Comments
COMMENT ON TABLE archon_configured_repositories IS 'Repositories using Agent Work Orders automation';
COMMENT ON COLUMN archon_configured_repositories.workflow_template_id IS 'Default workflow template (links to Context Hub)';
COMMENT ON COLUMN archon_configured_repositories.coding_standard_ids IS 'Array of coding standard UUIDs';
COMMENT ON COLUMN archon_configured_repositories.priming_context IS 'Repository-specific context: paths, architecture (JSONB)';
COMMENT ON COLUMN archon_configured_repositories.use_template_execution IS 'Flag: true=templates, false=hardcoded .md files';
COMMENT ON COLUMN archon_configured_repositories.default_sandbox_type IS 'Default sandbox: git_worktree, full_clone, or tmp_dir';
COMMENT ON COLUMN archon_configured_repositories.default_commands IS 'Default workflow commands (JSONB array)';

RAISE NOTICE '✓ Step 1: archon_configured_repositories table created';

-- =====================================================
-- STEP 2: Create archon_repository_agent_overrides table (NEW)
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_repository_agent_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES archon_configured_repositories(id) ON DELETE CASCADE,
    agent_template_id UUID NOT NULL REFERENCES archon_agent_templates(id) ON DELETE CASCADE,

    -- Repository-specific overrides (NULL = use template defaults)
    override_tools JSONB,
    override_standards JSONB,

    -- Metadata
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

RAISE NOTICE '✓ Step 2: archon_repository_agent_overrides table created';

-- =====================================================
-- STEP 3: Create archon_agent_work_orders table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_agent_work_orders (
    -- Primary identification (TEXT not UUID - generated by id_generator.py)
    agent_work_order_id TEXT PRIMARY KEY,

    -- Core state fields
    repository_url TEXT NOT NULL,
    sandbox_identifier TEXT NOT NULL,
    git_branch_name TEXT,
    agent_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),

    -- Metadata (stores sandbox_type, github_issue_number, current_phase, error_message, etc.)
    metadata JSONB DEFAULT '{}'::jsonb,

    -- NEW: Step selection
    selected_steps JSONB DEFAULT '[]',

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_status
    ON archon_agent_work_orders(status);
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_created_at
    ON archon_agent_work_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_repository
    ON archon_agent_work_orders(repository_url);
CREATE INDEX IF NOT EXISTS idx_agent_work_orders_metadata
    ON archon_agent_work_orders USING GIN(metadata);

-- Trigger
CREATE TRIGGER update_agent_work_orders_updated_at
    BEFORE UPDATE ON archon_agent_work_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security
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

-- Comments
COMMENT ON TABLE archon_agent_work_orders IS 'Agent work orders with state and metadata (ACID guarantees)';
COMMENT ON COLUMN archon_agent_work_orders.agent_work_order_id IS 'Unique work order ID (TEXT format from id_generator.py)';
COMMENT ON COLUMN archon_agent_work_orders.status IS 'Current status: pending, running, completed, or failed';
COMMENT ON COLUMN archon_agent_work_orders.metadata IS 'JSONB metadata: sandbox_type, github_issue_number, current_phase, error_message, etc.';
COMMENT ON COLUMN archon_agent_work_orders.selected_steps IS 'Array of steps to execute (user can toggle on/off) - NEW';

RAISE NOTICE '✓ Step 3: archon_agent_work_orders table created';

-- =====================================================
-- STEP 4: Create archon_agent_work_order_steps table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_agent_work_order_steps (
    -- Primary identification
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Foreign key to work order (CASCADE delete)
    agent_work_order_id TEXT NOT NULL REFERENCES archon_agent_work_orders(agent_work_order_id) ON DELETE CASCADE,

    -- Step execution details (EXISTING fields)
    step TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    output TEXT,
    error_message TEXT,
    duration_seconds FLOAT NOT NULL,
    session_id TEXT,
    executed_at TIMESTAMPTZ NOT NULL,
    step_order INT NOT NULL,

    -- NEW: Sub-workflow tracking
    sub_step_results JSONB DEFAULT '[]'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_work_order_steps_work_order_id
    ON archon_agent_work_order_steps(agent_work_order_id);
CREATE INDEX IF NOT EXISTS idx_agent_work_order_steps_executed_at
    ON archon_agent_work_order_steps(executed_at);

-- Row Level Security
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

-- Comments
COMMENT ON TABLE archon_agent_work_order_steps IS 'Step execution history for work orders with foreign key constraints';
COMMENT ON COLUMN archon_agent_work_order_steps.agent_work_order_id IS 'Foreign key to work order (CASCADE delete)';
COMMENT ON COLUMN archon_agent_work_order_steps.step IS 'WorkflowStep enum value (e.g., "planning", "execute")';
COMMENT ON COLUMN archon_agent_work_order_steps.sub_step_results IS 'Results from sub-workflow execution (NEW)';

RAISE NOTICE '✓ Step 4: archon_agent_work_order_steps table created';

-- =====================================================
-- STEP 5: Enable Agent Work Orders feature (default: disabled)
-- =====================================================

INSERT INTO archon_credentials (key, value, is_encrypted, category, description)
VALUES (
  'AGENT_WORK_ORDERS_ENABLED',
  'false',
  FALSE,
  'features',
  'Enable Agent Work Orders feature for automated development workflows'
)
ON CONFLICT (key) DO NOTHING;

RAISE NOTICE '✓ Step 5: Agent Work Orders feature setting created (default: disabled)';

COMMIT;

-- =====================================================
-- Migration Summary
-- =====================================================

DO $$
DECLARE
  repo_count INT;
  override_count INT;
  work_order_count INT;
  step_count INT;
BEGIN
  SELECT COUNT(*) INTO repo_count FROM archon_configured_repositories;
  SELECT COUNT(*) INTO override_count FROM archon_repository_agent_overrides;
  SELECT COUNT(*) INTO work_order_count FROM archon_agent_work_orders;
  SELECT COUNT(*) INTO step_count FROM archon_agent_work_order_steps;

  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Agent Work Orders Migration Complete';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Configured Repositories: %', repo_count;
  RAISE NOTICE 'Agent Overrides: %', override_count;
  RAISE NOTICE 'Work Orders: %', work_order_count;
  RAISE NOTICE 'Work Order Steps: %', step_count;
  RAISE NOTICE '';
  RAISE NOTICE 'Next Steps:';
  RAISE NOTICE '1. Restart Archon services: docker compose restart';
  RAISE NOTICE '2. Start AWO service: uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload';
  RAISE NOTICE '3. Enable Agent Work Orders in Settings UI (disabled by default)';
  RAISE NOTICE '4. Configure repositories and create work orders';
  RAISE NOTICE '';
  RAISE NOTICE 'IMPORTANT: This migration preserves all existing AWO functionality';
  RAISE NOTICE 'New template features are optional and flag-gated (use_template_execution)';
  RAISE NOTICE '========================================';
END $$;
