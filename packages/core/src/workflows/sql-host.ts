import { signalWorkflowWait, deleteWorkflowRun } from '../db/workflows';
import type { IWorkflowHostStore, WorkflowHost } from './host-store';
import * as isolationDb from '../db/isolation-environments';
import * as codebases from '../db/codebases';
import * as users from '../db/users';
import * as conversations from '../db/conversations';
import * as messages from '../db/messages';
import { createWorkflowStore, createWorkflowDeps } from './store-adapter';
import type { IWorkflowStore } from '@archon/workflows/store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import {
  createWorkflowOperations,
  type WorkflowOperations,
} from '../operations/workflow-operations';
import { requestDetachedRunStop } from '../services/run-owner-stop';
import { isRunOwnedByThisProcess, isRunOwnerAnswering } from '../services/run-live-owner';

export function createWorkflowHostStore(): IWorkflowHostStore {
  return {
    codebases,
    users,
    conversations,
    messages,
    isolation: {
      ...isolationDb.createIsolationStore(),
      listByCodebase: isolationDb.listByCodebase,
      findLatestByCodebaseAndWorkingPath: isolationDb.findLatestByCodebaseAndWorkingPath,
    },
  };
}

export function createSqlWorkflowOperations(
  store: IWorkflowStore = createWorkflowStore(),
  hostStore: IWorkflowHostStore = createWorkflowHostStore()
): WorkflowOperations {
  return createWorkflowOperations({
    getUserRole: async userId => (await hostStore.users.getUserById(userId))?.role,
    store: { ...store, signalWorkflowWait, deleteWorkflowRun },
    hostStore,
    requestDetachedRunStop,
    isRunOwnedByThisProcess,
    isRunOwnerAnswering,
    reclaimRunWorktree: async (run, isolation) => {
      const { reclaimRunWorktree } = await import('../services/cleanup-service');
      return reclaimRunWorktree(run, isolation);
    },
    reclaimContainerEnv: async (envId, isolation) => {
      const { reclaimContainerEnv } = await import('../services/cleanup-service');
      await reclaimContainerEnv(envId, isolation);
    },
  });
}

export function createSqlWorkflowHost(deps = createWorkflowDeps()): WorkflowHost {
  const records = createWorkflowHostStore();
  return {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
    operations: createSqlWorkflowOperations(deps.store, records),
  };
}
