-- Add isolation provider abstraction columns
-- Version: 5.0
-- Description: Abstract isolation mechanisms (worktrees, containers, VMs)

ALTER TABLE remote_agent_conversations
ADD COLUMN IF NOT EXISTS isolation_env_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS isolation_provider VARCHAR(50) DEFAULT 'worktree';

-- Migrate existing worktree_path data
UPDATE remote_agent_conversations
SET isolation_env_id = worktree_path,
    isolation_provider = 'worktree'
WHERE worktree_path IS NOT NULL
  AND isolation_env_id IS NULL;

-- Create index for lookups by isolation environment
CREATE INDEX IF NOT EXISTS idx_conversations_isolation
ON remote_agent_conversations(isolation_env_id, isolation_provider);

-- Note: Keep worktree_path for backwards compatibility during transition
-- Future migration will DROP COLUMN worktree_path after full migration
COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'Unique identifier for the isolated environment (worktree path, container ID, etc.)';
COMMENT ON COLUMN remote_agent_conversations.isolation_provider IS
  'Type of isolation provider (worktree, container, vm, remote)';
