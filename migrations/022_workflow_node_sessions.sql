-- Per-workflow-node provider session IDs persisted across re-runs
-- Version: 22.0
-- Description: When a workflow node opts in via `persist_session: true`, the executor stores
--   the provider's session ID here keyed by (workflow_name, node_id, scope_key, provider).
--   On the next run with the same scope_key (typically conversation_id), the executor passes
--   the stored ID back as `resumeSessionId` so each node continues its prior conversation.
--   scope_key is polymorphic TEXT — usually a conversation UUID, but kept FK-free for future
--   alternative scopes. There is no cascade on conversation delete: conversation deletion is a
--   soft delete and the conversation UUID is never reused, so leftover rows are unreachable and
--   harmless. A future hard-delete path should delete rows for the affected scope_key itself.

CREATE TABLE IF NOT EXISTS remote_agent_workflow_node_sessions (
  workflow_name VARCHAR(255) NOT NULL,
  node_id VARCHAR(255) NOT NULL,
  scope_key TEXT NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id TEXT NOT NULL,
  last_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (workflow_name, node_id, scope_key, provider)
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_scope
  ON remote_agent_workflow_node_sessions(scope_key);

CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_workflow
  ON remote_agent_workflow_node_sessions(workflow_name);

COMMENT ON TABLE remote_agent_workflow_node_sessions IS
  'Per-node provider session IDs persisted across workflow re-runs. Keyed by (workflow, node, scope, provider). Scope is typically conversation UUID.';
