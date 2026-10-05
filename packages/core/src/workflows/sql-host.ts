import type { IWorkflowHostStore } from './host-store';
import * as isolationDb from '../db/isolation-environments';
import * as codebases from '../db/codebases';
import * as users from '../db/users';
import * as conversations from '../db/conversations';
import * as messages from '../db/messages';
import { createWorkflowStore, createWorkflowDeps } from './store-adapter';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
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
    store,
    hostStore,
    requestDetachedRunStop,
    isRunOwnedByThisProcess,
    isRunOwnerAnswering,
    reclaimContainerEnv: async (envId, isolation) => {
      const { reclaimContainerEnv } = await import('../services/cleanup-service');
      await reclaimContainerEnv(envId, isolation);
    },
  });
}

export function createSqlWorkflowHost(): {
  deps: ReturnType<typeof createWorkflowDeps>;
  records: IWorkflowHostStore;
  engine: IWorkflowEngine;
  operations: WorkflowOperations;
} {
  const deps = createWorkflowDeps();
  const records = createWorkflowHostStore();
  return {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
    operations: createSqlWorkflowOperations(deps.store, records),
  };
}
