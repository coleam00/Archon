import { createLogger } from '@archon/paths';
import type {
  IsolationEnvironmentRow,
  CreateEnvironmentParams,
  IsolationWorkflowType,
} from './types';

export interface IIsolationStore {
  getById(id: string): Promise<IsolationEnvironmentRow | null>;
  findActiveByWorkflow(
    codebaseId: string,
    workflowType: IsolationWorkflowType,
    workflowId: string
  ): Promise<IsolationEnvironmentRow | null>;
  create(env: CreateEnvironmentParams): Promise<IsolationEnvironmentRow>;
  updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void>;
  updateStatus(id: string, status: 'active' | 'destroyed'): Promise<void>;
  countActiveByCodebase(codebaseId: string): Promise<number>;
}

/** Reuse must not revoke the creation proof used by the run that created the checkout. */
export async function recordWorktreeAdoption(
  store: Pick<IIsolationStore, 'updateMetadata'>,
  env: IsolationEnvironmentRow
): Promise<IsolationEnvironmentRow> {
  if (env.provider !== 'worktree') return env;
  await store.updateMetadata(env.id, { adopted: true });
  createLogger('isolation.store').warn(
    {
      envId: env.id,
      codebaseId: env.codebase_id,
      workflowType: env.workflow_type,
      identifier: env.workflow_id,
      branchName: env.branch_name,
      worktreePath: env.working_path,
    },
    'worktree_adopted'
  );
  return { ...env, metadata: { ...env.metadata, adopted: true } };
}
