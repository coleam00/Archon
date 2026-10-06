import type { components } from '@/lib/api.generated';

type Detail = components['schemas']['WorkflowRunDetail'];
export type TerminalRecord = NonNullable<Detail['run']['terminal_record']>;

export function terminalRecord(
  returns: TerminalRecord['returns'],
  outcome: TerminalRecord['outcome'] = 'failed'
): TerminalRecord {
  return {
    run_id: 'run-1',
    status: 'completed',
    outcome,
    error: null,
    first_failed_node: null,
    nodes: [{ node_id: 'outcome', state: 'completed' }],
    returns,
    artifacts: { root: null, files: [], limitations: [] },
  };
}

export const detailFixture: Detail = {
  run: {
    origin: { conversationId: 'conversation-1' },
    id: 'run-1',
    workflow_name: 'review',
    conversation_id: 'conversation-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'completed',
    outcome: 'failed',
    user_message: '',
    metadata: {},
    started_at: '2026-10-05T10:00:00Z',
    completed_at: '2026-10-05T10:01:00Z',
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    conversation_platform_id: null,
    terminal_record: terminalRecord({
      availability: 'available',
      node_id: 'outcome',
      value: { delivered: false, summary: 'An open PR already implements this fix.' },
    }),
    nodes: [{ node_id: 'outcome', state: 'completed' }],
  },
  events: [
    {
      id: 'event-1',
      workflow_run_id: 'run-1',
      event_type: 'node_completed',
      step_index: null,
      step_name: 'outcome',
      data: {},
      created_at: '2026-10-05T10:01:00Z',
    },
  ],
};
