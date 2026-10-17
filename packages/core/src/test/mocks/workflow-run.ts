import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export const mockWorkflowRun: WorkflowRun = {
  origin: { conversationId: 'conv-456' },
  id: 'workflow-run-123',
  workflow_name: 'feature-development',
  conversation_id: 'conv-456',
  parent_conversation_id: null,
  codebase_id: 'codebase-789',
  status: 'running',
  outcome: null,
  user_message: 'Add dark mode support',
  metadata: {},
  started_at: new Date('2025-01-01T00:00:00Z'),
  completed_at: null,
  last_activity_at: new Date('2025-01-01T00:00:00Z'),
  working_path: null,
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
};
