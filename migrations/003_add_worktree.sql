-- Add worktree support to conversations
-- Version: 3.0
-- Description: Allow each conversation to work in an isolated git worktree

ALTER TABLE remote_agent_conversations
ADD COLUMN worktree_path VARCHAR(500);

-- Add comment for documentation
COMMENT ON COLUMN remote_agent_conversations.worktree_path IS
  'Path to git worktree for this conversation. If set, AI works here instead of cwd.';
