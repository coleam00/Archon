-- Add index for worktree_path lookups (for sharing worktrees between issue/PR)
CREATE INDEX IF NOT EXISTS idx_remote_agent_conversations_worktree
ON remote_agent_conversations(worktree_path)
WHERE worktree_path IS NOT NULL;
