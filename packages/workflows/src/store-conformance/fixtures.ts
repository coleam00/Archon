import { expect } from 'bun:test';
import type { AttentionAnswerWrite, GateResolutionEvent, IWorkflowStore } from '../store';
import type { ApprovalContext, WorkflowWaitContext, WorkflowRun } from '../schemas/workflow-run';

// Host records referenced by the port's inputs must exist in relational targets.
export const CONFORMANCE_CODEBASE_ID = '00000000-0000-4000-8000-000000003643';
export const CONFORMANCE_CONVERSATION_ID = '00000000-0000-4000-8001-000000003643';
export const approval: ApprovalContext = {
  nodeId: 'review',
  message: 'Choose',
  type: 'approval',
  pauseId: 'first',
};
export const wait: Extract<WorkflowWaitContext, { kind: 'time' }> = {
  owner: 'node',
  nodeId: 'wait',
  kind: 'time',
  waitingSince: '2026-01-01T00:00:00.000Z',
  resumeAt: '2026-01-02T00:00:00.000Z',
};
export const attentionWait: Extract<WorkflowWaitContext, { kind: 'attention' }> = {
  owner: 'node',
  nodeId: 'ask',
  kind: 'attention',
  waitingSince: '2026-01-01T00:00:00.000Z',
  message: 'Which base?',
  pauseId: 'ask-1',
  form: 'select',
  options: [{ id: 'use-main' }, { id: 'use-dev' }],
};
export const answeredAttention = (
  answer: string,
  pause: Extract<WorkflowWaitContext, { kind: 'attention' }> = attentionWait
): Extract<WorkflowWaitContext, { kind: 'attention' }> => ({
  ...pause,
  answer: { decision: answer, text: '' },
  answeredVia: 'cli',
  answeredAt: '2026-01-01T00:05:00.000Z',
});
export const attentionAnswer = (decision: string, pauseId = 'ask-1'): AttentionAnswerWrite => ({
  pauseId,
  answer: { decision, text: '' },
  answeredVia: 'cli',
  answeredAt: '2026-01-01T00:05:00.000Z',
});
export const schedule = {
  reason: 'quota' as const,
  attempt: 1,
  maxAttempts: 3,
  resumeAt: wait.resumeAt,
  deadlineAt: '2026-01-03T00:00:00.000Z',
};
/** Fail a run as an older binary did, with its quota schedule; this binary only reads one. */
export async function failWithSchedule(
  store: Pick<IWorkflowStore, 'failWorkflowRun' | 'updateWorkflowRun'>,
  id: string
): Promise<void> {
  await store.failWorkflowRun(id, 'quota');
  await store.updateWorkflowRun(id, { metadata: { scheduled_resume: schedule } });
}
export const eight = <T>(call: (index: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: 8 }, (_, index) => call(index)));
export const create = (
  store: Pick<IWorkflowStore, 'createWorkflowRun'>,
  input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {}
): Promise<WorkflowRun> =>
  store.createWorkflowRun({ workflow_name: 'conformance', user_message: 'test', ...input });
export async function running(
  store: Pick<IWorkflowStore, 'createWorkflowRun' | 'claimPendingWorkflowRun'>,
  input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {}
): Promise<WorkflowRun> {
  const run = await create(store, input);
  const claimed = await store.claimPendingWorkflowRun(run.id);
  expect(claimed?.status).toBe('running');
  return run;
}
export const types = async (
  store: Pick<IWorkflowStore, 'listWorkflowEvents'>,
  id: string
): Promise<string[]> => (await store.listWorkflowEvents(id)).map(event => event.event_type);
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the store operation to reject');
}
export const gateEvents = (index: number): GateResolutionEvent[] => [
  {
    event_type: 'approval_received',
    step_name: 'review',
    data: { winner: index },
  },
  { event_type: 'node_completed', step_name: 'review', data: { node_output: String(index) } },
];
