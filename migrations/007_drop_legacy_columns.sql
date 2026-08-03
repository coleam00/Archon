-- Drop legacy isolation columns
-- Version: 7.0
-- Description: Complete migration to work-centric isolation model
-- PREREQUISITE: Run verification query to ensure no orphaned data before applying!
--
-- Verification query (should return 0 rows):
-- SELECT id, platform_conversation_id, worktree_path, isolation_env_id_legacy
-- FROM remote_agent_conversations
-- WHERE (worktree_path IS NOT NULL OR isolation_env_id_legacy IS NOT NULL)
--   AND isolation_env_id IS NULL;

-- Drop columns (order matters - drop FK references first if any)
ALTER TABLE remote_agent_conversations
  DROP COLUMN IF EXISTS worktree_path;

ALTER TABLE remote_agent_conversations
  DROP COLUMN IF EXISTS isolation_env_id_legacy;

ALTER TABLE remote_agent_conversations
  DROP COLUMN IF EXISTS isolation_provider;

-- Drop the legacy index created in migration 005 (if it exists)
DROP INDEX IF EXISTS idx_conversations_isolation;

-- Add comment for documentation
COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';
