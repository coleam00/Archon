import type { IIsolationStore } from '../../store';
import type {
  ContainerBackendConfig,
  CreateEnvironmentParams,
  IsolationEnvironmentRow,
} from '../../types';
import type { DockerExecResult, DockerRunner } from '../../container/docker-exec';

export const CONFIG: ContainerBackendConfig = {
  image: 'archon-runner:test',
  network: 'bridge',
  memoryMb: 4096,
  pidsLimit: 512,
};

export const FOLDER = {
  id: 'cb-1',
  defaultCwd: '/tmp/ops-client',
  name: 'ops-client',
  kind: 'folder' as const,
};

/** In-memory store capturing the created row and exposing it for destroy(). */
export function fakeStore(): IIsolationStore & {
  rows: Map<string, IsolationEnvironmentRow>;
  created?: CreateEnvironmentParams;
} {
  const rows = new Map<string, IsolationEnvironmentRow>();
  let counter = 0;
  return {
    rows,
    created: undefined,
    async getById(id) {
      return rows.get(id) ?? null;
    },
    listActive: async () => [],
    async findActiveByWorkflow() {
      return null;
    },
    async create(env) {
      this.created = env;
      const row: IsolationEnvironmentRow = {
        id: `env-${++counter}`,
        codebase_id: env.codebase_id,
        workflow_type: env.workflow_type,
        workflow_id: env.workflow_id,
        provider: env.provider ?? 'container',
        working_path: env.working_path,
        branch_name: env.branch_name,
        status: 'active',
        created_at: new Date(),
        created_by_platform: env.created_by_platform ?? null,
        created_by_user_id: env.created_by_user_id ?? null,
        metadata: env.metadata ?? {},
      };
      rows.set(row.id, row);
      return row;
    },
    async updateMetadata(id, metadata) {
      const row = rows.get(id);
      if (!row) throw new Error('Missing environment');
      row.metadata = { ...row.metadata, ...metadata };
    },
    async updateStatus(id, status) {
      const row = rows.get(id);
      if (row) row.status = status;
    },
    withWorktreeRegistration: async () => {
      throw new Error('Unexpected worktree removal');
    },
    async markWorktreeDestroyed() {
      throw new Error('Unexpected worktree retirement');
    },
    async countActiveByCodebase() {
      return 0;
    },
  };
}

/**
 * Build a DockerRunner from a per-command handler. `handler` returns the result
 * or throws; unmatched commands return empty stdout. Records every call.
 */
export function fakeDocker(
  handler: (args: string[]) => DockerExecResult | Promise<DockerExecResult>
): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (async (args: string[]) => {
    calls.push(args);
    return handler(args);
  }) as DockerRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

/** Seed an active container env row with full metadata (as prepare would leave it). */
export function seedContainerRow(
  store: ReturnType<typeof fakeStore>,
  meta?: Partial<Record<string, unknown>>
): IsolationEnvironmentRow {
  const row: IsolationEnvironmentRow = {
    id: 'env-c',
    codebase_id: 'cb-1',
    workflow_type: 'task',
    workflow_id: 'res-1',
    provider: 'container',
    working_path: '/tmp/ops-client',
    branch_name: '' as unknown as IsolationEnvironmentRow['branch_name'],
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'cli',
    created_by_user_id: null,
    metadata: {
      containerId: 'cid-orig',
      containerName: 'archon-res-1',
      volume: 'archon-res-1-upper',
      image: 'archon-runner:test',
      resourceId: 'res-1',
      workspacePath: '/tmp/ops-client',
      overlayMode: 'fuse',
      ...meta,
    },
  };
  store.rows.set(row.id, row);
  return row;
}
