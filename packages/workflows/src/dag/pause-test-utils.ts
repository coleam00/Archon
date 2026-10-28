import { mock } from 'bun:test';
import { newNodeInvocation, startNodeExecution, finishNodeExecution } from '../node-execution';
import { serializeNodeStateRecord } from '../node-record-serialization';
import { dagNodeSchema } from '../schemas';
import type { PersistedNodeOutput } from '../store';
import type { WorkflowWaitContext, WorkflowRunStatus } from '../schemas';
import { WorkflowRunPauseConflictError, type IWorkflowStore } from '../store';
import { createMockStore, mockWorkflowRun, type MockWorkflowStore } from './test-utils';

/**
 * Gate tests need the production running-to-paused CAS and subsequent reads of
 * its owner; the default static mocks cannot exercise concurrent admission.
 */
export function createEscalationStore(
  runId: string,
  onWaitPaused?: (wait: WorkflowWaitContext) => WorkflowWaitContext
): MockWorkflowStore & {
  getState: () => { status: WorkflowRunStatus; metadata: Record<string, unknown> };
} {
  const base = createMockStore();
  let status: WorkflowRunStatus = 'running';
  let metadata: Record<string, unknown> = {};
  return {
    ...base,
    getWorkflowRunStatus: mock<IWorkflowStore['getWorkflowRunStatus']>(async _id => status),
    getWorkflowRun: mock<IWorkflowStore['getWorkflowRun']>(async _id => ({
      ...mockWorkflowRun(runId),
      status,
      metadata,
    })),
    pauseWorkflowRun: mock<IWorkflowStore['pauseWorkflowRun']>(
      async (_id, approvalContext, extraMetadata, suspension) => {
        if (status !== 'running') throw new WorkflowRunPauseConflictError(runId);
        status = 'paused';
        metadata = { ...metadata, ...(extraMetadata ?? {}), approval: { ...approvalContext } };
        if (suspension) await base.persistWorkflowEvent(suspension);
      }
    ),
    pauseWorkflowRunForWait: mock<NonNullable<IWorkflowStore['pauseWorkflowRunForWait']>>(
      async (_id, waitContext) => {
        status = 'paused';
        metadata = {
          ...metadata,
          wait: { ...(onWaitPaused?.(waitContext) ?? waitContext) },
        };
      }
    ),
    getState: () => ({ status, metadata }),
  };
}

export function seedPreviousLoopGroupPass(
  store: MockWorkflowStore,
  runId: string,
  groupId: string,
  iteration: number,
  outputs: ReadonlyMap<string, PersistedNodeOutput>
): void {
  const rows = [...outputs].map(([path, output]) => {
    const parsed = dagNodeSchema.parse({ id: path.split('.').pop(), bash: 'true' });
    if (parsed.kind !== 'exec') throw new Error('Expected exec');
    const record = startNodeExecution({
      runId,
      path,
      node: parsed,
      invocation: newNodeInvocation([{ groupId, iteration }]),
    });
    return {
      ...serializeNodeStateRecord(
        finishNodeExecution(
          record,
          { status: 'completed' },
          {
            output: { text: output.output },
          }
        )
      ),
      id: record.attempt.id,
      step_index: null,
      created_at: record.timing.startedAt,
    };
  });
  store.listEventsForRuns.mockResolvedValue(new Map([[runId, rows]]));
}
