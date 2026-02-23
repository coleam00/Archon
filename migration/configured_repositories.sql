-- =====================================================
-- Agent Work Orders - Configured Repositories
-- =====================================================
-- Creates the archon_configured_repositories table for managing
-- GitHub repository configurations, verification status, and
-- per-repository workflow preferences.
--
-- Run AFTER agent_work_orders_state.sql
-- Run this in your Supabase SQL Editor
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_configured_repositories (
    -- Primary identification (UUID auto-generated)
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Repository identity
    repository_url TEXT NOT NULL UNIQUE,
    display_name TEXT,                    -- e.g. "owner/repo-name"
    owner TEXT,                           -- repository owner/organization
    default_branch TEXT,                  -- e.g. "main" or "master"

    -- Verification status
    is_verified BOOLEAN NOT NULL DEFAULT false,
    last_verified_at TIMESTAMP WITH TIME ZONE,

    -- Per-repository workflow preferences
    default_sandbox_type TEXT NOT NULL DEFAULT 'git_worktree'
        CHECK (default_sandbox_type IN ('git_branch', 'git_worktree', 'e2b', 'dagger')),
    default_commands TEXT[] NOT NULL DEFAULT ARRAY[
        'create-branch', 'planning', 'execute', 'commit', 'create-pr'
    ],

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_configured_repositories_url
    ON archon_configured_repositories(repository_url);

CREATE INDEX IF NOT EXISTS idx_configured_repositories_owner
    ON archon_configured_repositories(owner);

CREATE INDEX IF NOT EXISTS idx_configured_repositories_created_at
    ON archon_configured_repositories(created_at DESC);

-- =====================================================
-- TRIGGER
-- =====================================================

DROP TRIGGER IF EXISTS update_configured_repositories_updated_at ON archon_configured_repositories;
CREATE TRIGGER update_configured_repositories_updated_at
    BEFORE UPDATE ON archon_configured_repositories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE archon_configured_repositories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access to archon_configured_repositories" ON archon_configured_repositories;
CREATE POLICY "Allow service role full access to archon_configured_repositories"
    ON archon_configured_repositories
    FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Allow authenticated users full access to archon_configured_repositories" ON archon_configured_repositories;
CREATE POLICY "Allow authenticated users full access to archon_configured_repositories"
    ON archon_configured_repositories
    FOR ALL
    TO authenticated
    USING (true);

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'archon_configured_repositories'
    ) THEN
        RAISE NOTICE '✓ Table archon_configured_repositories created successfully';
    ELSE
        RAISE EXCEPTION '✗ Table archon_configured_repositories was not created';
    END IF;
END $$;

-- =====================================================
-- ROLLBACK
-- =====================================================

/*
DROP TABLE IF EXISTS archon_configured_repositories CASCADE;
*/
