-- =====================================================
-- Agent Work Orders - Repository Configuration
-- =====================================================
-- This migration creates the archon_configured_repositories table
-- for storing configured GitHub repositories with metadata and preferences
--
-- Features:
-- - Repository URL validation and uniqueness
-- - GitHub metadata storage (display_name, owner, default_branch)
-- - Verification status tracking
-- - Per-repository preferences (sandbox type, workflow commands)
-- - Automatic timestamp management
-- - Row Level Security policies
--
-- Run this in your Supabase SQL Editor
-- =====================================================

-- =====================================================
-- SECTION 1: CREATE TABLE
-- =====================================================

-- Create archon_configured_repositories table
CREATE TABLE IF NOT EXISTS archon_configured_repositories (
    -- Primary identification
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Repository identification
    repository_url TEXT NOT NULL UNIQUE,
    display_name TEXT,                  -- Extracted from GitHub (e.g., "owner/repo")
    owner TEXT,                         -- Extracted from GitHub
    default_branch TEXT,                -- Extracted from GitHub (e.g., "main")

    -- Verification status
    is_verified BOOLEAN DEFAULT false,
    last_verified_at TIMESTAMP WITH TIME ZONE,

    -- Per-repository preferences
    -- Note: default_sandbox_type is intentionally restricted to production-ready types only.
    -- Experimental types (git_branch, e2b, dagger) are blocked for safety and stability.
    default_sandbox_type TEXT DEFAULT 'git_worktree'
        CHECK (default_sandbox_type IN ('git_worktree', 'full_clone', 'tmp_dir')),
    default_commands JSONB DEFAULT '["create-branch", "planning", "execute", "commit", "create-pr"]'::jsonb,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- URL validation constraint
    CONSTRAINT valid_repository_url CHECK (
        repository_url ~ '^https://github\.com/[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+/?$'
    )
);

-- =====================================================
-- SECTION 2: CREATE INDEXES
-- =====================================================

-- Unique index on repository_url (enforces constraint)
CREATE UNIQUE INDEX IF NOT EXISTS idx_configured_repositories_url
    ON archon_configured_repositories(repository_url);

-- Index on is_verified for filtering verified repositories
CREATE INDEX IF NOT EXISTS idx_configured_repositories_verified
    ON archon_configured_repositories(is_verified);

-- Index on created_at for ordering by most recent
CREATE INDEX IF NOT EXISTS idx_configured_repositories_created_at
    ON archon_configured_repositories(created_at DESC);

-- GIN index on default_commands JSONB for querying by commands
CREATE INDEX IF NOT EXISTS idx_configured_repositories_commands
    ON archon_configured_repositories USING GIN(default_commands);

-- =====================================================
-- SECTION 3: CREATE TRIGGER
-- =====================================================

-- Apply auto-update trigger for updated_at timestamp
-- Reuses existing update_updated_at_column() function from complete_setup.sql
CREATE TRIGGER update_configured_repositories_updated_at
    BEFORE UPDATE ON archon_configured_repositories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SECTION 4: ROW LEVEL SECURITY
-- =====================================================

-- Enable Row Level Security on the table
ALTER TABLE archon_configured_repositories ENABLE ROW LEVEL SECURITY;

-- Policy 1: Service role has full access (for API operations)
CREATE POLICY "Allow service role full access to archon_configured_repositories"
    ON archon_configured_repositories
    FOR ALL
    USING (auth.role() = 'service_role');

-- Policy 2: Authenticated users can read and update (for frontend operations)
CREATE POLICY "Allow authenticated users to read and update archon_configured_repositories"
    ON archon_configured_repositories
    FOR ALL
    TO authenticated
    USING (true);

-- =====================================================
-- SECTION 5: TABLE COMMENTS
-- =====================================================

-- Add comments to document table structure
COMMENT ON TABLE archon_configured_repositories IS
    'Stores configured GitHub repositories for Agent Work Orders with metadata, verification status, and per-repository preferences';

COMMENT ON COLUMN archon_configured_repositories.id IS
    'Unique UUID identifier for the configured repository';

COMMENT ON COLUMN archon_configured_repositories.repository_url IS
    'GitHub repository URL (must be https://github.com/owner/repo format)';

COMMENT ON COLUMN archon_configured_repositories.display_name IS
    'Human-readable repository name extracted from GitHub API (e.g., "owner/repo-name")';

COMMENT ON COLUMN archon_configured_repositories.owner IS
    'Repository owner/organization name extracted from GitHub API';

COMMENT ON COLUMN archon_configured_repositories.default_branch IS
    'Default branch name extracted from GitHub API (typically "main" or "master")';

COMMENT ON COLUMN archon_configured_repositories.is_verified IS
    'Boolean flag indicating if repository access has been verified via GitHub API';

COMMENT ON COLUMN archon_configured_repositories.last_verified_at IS
    'Timestamp of last successful repository verification';

COMMENT ON COLUMN archon_configured_repositories.default_sandbox_type IS
    'Default sandbox type for work orders: git_worktree (default), full_clone, or tmp_dir.
     IMPORTANT: Intentionally restricted to production-ready types only.
     Experimental types (git_branch, e2b, dagger) are blocked by CHECK constraint for safety and stability.';

COMMENT ON COLUMN archon_configured_repositories.default_commands IS
    'JSONB array of default workflow commands for work orders (e.g., ["create-branch", "planning", "execute", "commit", "create-pr"])';

COMMENT ON COLUMN archon_configured_repositories.created_at IS
    'Timestamp when repository configuration was created';

COMMENT ON COLUMN archon_configured_repositories.updated_at IS
    'Timestamp when repository configuration was last updated (auto-managed by trigger)';

-- =====================================================
-- SECTION 6: VERIFICATION
-- =====================================================

-- Verify table creation
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

-- Verify indexes
DO $$
BEGIN
    IF (
        SELECT COUNT(*) FROM pg_indexes
        WHERE tablename = 'archon_configured_repositories'
    ) >= 4 THEN
        RAISE NOTICE '✓ Indexes created successfully';
    ELSE
        RAISE WARNING '⚠ Expected at least 4 indexes, found fewer';
    END IF;
END $$;

-- Verify trigger
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'archon_configured_repositories'::regclass
        AND tgname = 'update_configured_repositories_updated_at'
    ) THEN
        RAISE NOTICE '✓ Trigger update_configured_repositories_updated_at created successfully';
    ELSE
        RAISE EXCEPTION '✗ Trigger update_configured_repositories_updated_at was not created';
    END IF;
END $$;

-- Verify RLS policies
DO $$
BEGIN
    IF (
        SELECT COUNT(*) FROM pg_policies
        WHERE tablename = 'archon_configured_repositories'
    ) >= 2 THEN
        RAISE NOTICE '✓ RLS policies created successfully';
    ELSE
        RAISE WARNING '⚠ Expected at least 2 RLS policies, found fewer';
    END IF;
END $$;

-- =====================================================
-- SECTION 7: ROLLBACK INSTRUCTIONS
-- =====================================================

/*
To rollback this migration, run the following commands:

-- Drop the table (CASCADE will also drop indexes, triggers, and policies)
DROP TABLE IF EXISTS archon_configured_repositories CASCADE;

-- Verify table is dropped
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name = 'archon_configured_repositories';
-- Should return 0 rows

-- Note: The update_updated_at_column() function is shared and should NOT be dropped
*/

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- The archon_configured_repositories table is now ready for use
-- Next steps:
-- 1. Restart Agent Work Orders service to detect the new table
-- 2. Test repository configuration via API endpoints
-- 3. Verify health endpoint shows table_exists=true
-- =====================================================
