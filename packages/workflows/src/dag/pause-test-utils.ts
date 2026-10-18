import { mock } from 'bun:test';
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
