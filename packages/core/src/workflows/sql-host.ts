import type { IWorkflowHostStore } from './host-store';
import { createIsolationStore } from '../db/isolation-environments';
import { createWorkflowStore } from './store-adapter';
import {
  createWorkflowOperations,
  type WorkflowOperations,
} from '../operations/workflow-operations';
import { requestDetachedRunStop } from '../services/run-owner-stop';
import { isRunOwnedByThisProcess, isRunOwnerAnswering } from '../services/run-live-owner';

export function createWorkflowHostStore(): IWorkflowHostStore {
  return { isolation: createIsolationStore() };
}

export function createSqlWorkflowOperations(): WorkflowOperations {
  return createWorkflowOperations({
    store: createWorkflowStore(),
    hostStore: createWorkflowHostStore(),
    requestDetachedRunStop,
    isRunOwnedByThisProcess,
    isRunOwnerAnswering,
    reclaimContainerEnv: async (envId, isolation) => {
      const { reclaimContainerEnv } = await import('../services/cleanup-service');
      await reclaimContainerEnv(envId, isolation);
    },
  });
}
