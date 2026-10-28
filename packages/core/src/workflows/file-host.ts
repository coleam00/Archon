import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { captureCodebaseRegistered, isPathInside } from '@archon/paths';
import {
  createFileWorkflowStore,
  commit,
  readJson,
  recoverBeforeRead,
  listRuns,
  FileStoreUnsupportedError,
} from '@archon/workflows/file-store';
import {
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
  ownedWorktreeSchema,
} from '@archon/workflows/schemas/workflow-run';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REGISTRATION_ID,
  WorktreeRegistrationChangedError,
  sameWorktreeRegistration,
  type IsolationEnvironmentRow,
} from '@archon/isolation/types';
import { userRowSchema, identityPlatformSchema } from '../schemas/user';
import { codebaseRowSchema, codebaseUpdateFields, type Codebase } from '../schemas/codebase';
import { isCheckoutRegistered } from '../services/project-registration-identity';
import {
  findRemoteOwner,
  assertProjectRegistrationAvailable,
} from '../services/registration-remote';
import { assertAbsoluteDefaultCwd } from '../db/codebase-path';
import type { IWorkflowHostStore, WorkflowHost } from './host-store';
import { assertFileStoreConfiguration } from '../config/store-selection';
import { completedRunWorktreeDeps, createWorkflowDeps } from './store-adapter';
import type { WorktreeOwnershipReaders } from '../services/cleanup/run-worktree';
import { createWorkflowOperations } from '../operations/workflow-operations';
import { requestDetachedRunStop } from '../services/run-owner-stop';
import { runOwnerLossWatch } from '../services/run-attention-watch';
import { attentionQueueSource } from '../operations/attention-queue';
import { isRunOwnedByThisProcess, isRunOwnerAnswering } from '../services/run-live-owner';

const worktreeReferenceSchema = ownedWorktreeSchema.pick({ envId: true }).loose();
const codebasesSchema = z.array(
  codebaseRowSchema.extend({
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    envVars: z.record(z.string(), z.string()).default({}),
  })
);
export const isolationSchema = z.array(
  z.object({
    id: z.string(),
    codebase_id: z.string(),
    workflow_type: z.enum(ISOLATION_WORKFLOW_TYPES),
    workflow_id: z.string(),
    provider: z.enum(ISOLATION_PROVIDER_TYPES),
    working_path: z.string(),
    branch_name: z.string(),
    status: z.enum(ENVIRONMENT_STATUSES),
    created_at: z.coerce.date(),
    created_by_platform: z.string().nullable(),
    created_by_user_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
);
const fileUserSchema = userRowSchema.extend({
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  platform: identityPlatformSchema,
  platform_user_id: z.string(),
});
export async function createFileWorkflowHost(root: string): Promise<WorkflowHost> {
  await assertFileStoreConfiguration();
  async function users(): Promise<z.infer<typeof fileUserSchema>[]> {
    return z.array(fileUserSchema).parse((await readJson(join(root, 'host/users.json'))) ?? []);
  }
  async function codebases(): Promise<z.infer<typeof codebasesSchema>> {
    const rows = codebasesSchema.parse((await readJson(join(root, 'host/codebases.json'))) ?? []);
    for (const row of rows) assertAbsoluteDefaultCwd(row.default_cwd, row.name);
    return rows;
  }
  async function environments(): Promise<IsolationEnvironmentRow[]> {
    return isolationSchema.parse((await readJson(join(root, 'host/isolation.json'))) ?? []);
  }
  async function readCodebases(): Promise<z.infer<typeof codebasesSchema>> {
    await recoverBeforeRead(root);
    return codebases();
  }
  async function readPublicCodebases(): Promise<Codebase[]> {
    return (await readCodebases()).map(row => codebaseRowSchema.parse(row));
  }
  async function readEnvironments(): Promise<IsolationEnvironmentRow[]> {
    await recoverBeforeRead(root);
    return environments();
  }
  async function updateCodebase(id: string, change: (row: Codebase) => void): Promise<void> {
    await commit(root, [], async () => {
      const rows = await codebases();
      const row = rows.find(row => row.id === id);
      if (!row) throw new Error(`Codebase ${id} not found`);
      change(row);
      assertAbsoluteDefaultCwd(row.default_cwd, row.name);
      row.updated_at = new Date();
      return { result: undefined, changes: { documents: { 'host/codebases.json': rows } } };
    });
  }
  const unsupported = (capability: string) => async (): Promise<never> => {
    throw new FileStoreUnsupportedError(capability);
  };
  const records: IWorkflowHostStore = {
    codebases: {
      getCodebase: async id => (await readPublicCodebases()).find(row => row.id === id) ?? null,
      listCodebases: async () =>
        (await readPublicCodebases()).sort((a, b) => a.name.localeCompare(b.name)),
      // The document is validated whole on every read, so it never holds an unreadable row.
      listCodebaseClaims: async () => readPublicCodebases(),
      findCodebaseByDefaultCwd: async cwd =>
        (await readPublicCodebases())
          .filter(row => row.default_cwd === cwd)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
      findCodebaseByPathPrefix: async cwd =>
        (await readPublicCodebases())
          .filter(row => isPathInside(row.default_cwd, cwd, { includeRoot: true, lexical: true }))
          .sort((a, b) => resolve(b.default_cwd).length - resolve(a.default_cwd).length)[0] ?? null,
      findCodebaseByName: async name =>
        (await readPublicCodebases())
          .filter(row => row.name === name)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
      findCodebaseByRepoUrl: async url => {
        const rows = await readPublicCodebases();
        return rows.find(row => row.repository_url === url) ?? findRemoteOwner(rows, url);
      },
      removeUnregisteredCheckout: async (path, remove) => {
        await commit(root, [], async () => {
          if (!(await isCheckoutRegistered(path, await codebases()))) await remove();
          return { result: undefined, changes: {} };
        });
      },
      createCodebase: async input => {
        assertAbsoluteDefaultCwd(input.default_cwd, input.name);
        const row = {
          id: randomUUID(),
          ...input,
          repository_url: input.repository_url ?? null,
          default_branch: input.default_branch ?? null,
          ai_assistant_type: input.ai_assistant_type ?? null,
          kind: input.kind ?? 'repo',
          commands: {},
          envVars: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        await commit(root, [], async () => {
          const registered = await codebases();
          await assertProjectRegistrationAvailable(row, registered);
          return {
            result: undefined,
            changes: { documents: { 'host/codebases.json': [...registered, row] } },
          };
        });
        captureCodebaseRegistered();
        return codebaseRowSchema.parse(row);
      },
      updateCodebase: (target, input) =>
        updateCodebase(target.id, row => {
          for (const field of codebaseUpdateFields) {
            const value = input[field];
            if (value !== undefined) Object.assign(row, { [field]: value });
          }
        }),
      getCodebaseCommands: async id => (await records.codebases.getCodebase(id))?.commands ?? {},
      updateCodebaseCommands: (id, commands) =>
        updateCodebase(id, row => {
          row.commands = commands;
        }),
    },
    users: {
      getUserById: async id => {
        await recoverBeforeRead(root);
        const row = (await users()).find(row => row.id === id);
        return row ? userRowSchema.parse(row) : null;
      },
      findOrCreateUserByPlatformIdentity: (platform, id, displayName) =>
        commit(root, [], async () => {
          const rows = await users();
          const prior = rows.find(row => row.platform === platform && row.platform_user_id === id);
          if (prior) return { result: userRowSchema.parse(prior), changes: {} };
          const row = fileUserSchema.parse({
            id: randomUUID(),
            platform,
            platform_user_id: id,
            display_name: displayName ?? null,
            email: null,
            role: userRowSchema.shape.role.enum.member,
            created_at: new Date(),
            updated_at: new Date(),
          });
          return {
            result: userRowSchema.parse(row),
            changes: { documents: { 'host/users.json': [...rows, row] } },
          };
        }),
    },
    conversations: {
      getConversationById: unsupported('conversations'),
      updateConversation: unsupported('conversations'),
    },
    messages: { addMessage: unsupported('messages') },
    isolation: {
      getById: async id => (await readEnvironments()).find(row => row.id === id) ?? null,
      findActiveByWorkflow: async (codebase, type, id) =>
        (await readEnvironments()).find(
          row =>
            row.codebase_id === codebase &&
            row.workflow_type === type &&
            row.workflow_id === id &&
            row.status === 'active'
        ) ?? null,
      create: input =>
        commit(root, [], async () => {
          const rows = await environments();
          const prior = rows.find(
            row =>
              row.codebase_id === input.codebase_id &&
              row.workflow_type === input.workflow_type &&
              row.workflow_id === input.workflow_id &&
              row.status === 'active'
          );
          const row: IsolationEnvironmentRow = {
            ...input,
            id: prior?.id ?? randomUUID(),
            provider: input.provider ?? 'worktree',
            created_by_platform: input.created_by_platform ?? null,
            created_by_user_id: prior
              ? prior.created_by_user_id
              : (input.created_by_user_id ?? null),
            metadata: {
              ...input.metadata,
              ...((input.provider ?? 'worktree') === 'worktree'
                ? { [WORKTREE_REGISTRATION_ID]: randomUUID() }
                : {}),
            },
            status: 'active',
            created_at: new Date(),
          };
          return {
            result: row,
            changes: {
              documents: { 'host/isolation.json': [...rows.filter(row => row !== prior), row] },
            },
          };
        }),
      updateMetadata: (id, metadata, observed) =>
        commit(root, [], async () => {
          const rows = await environments();
          const row = rows.find(row => row.id === id);
          if (!row) throw new Error(`Isolation environment ${id} not found`);
          if (observed && (row.status !== 'active' || !sameWorktreeRegistration(row, observed))) {
            throw new Error(`Worktree ${id} changed during adoption; inspect it and retry`);
          }
          row.metadata = { ...row.metadata, ...metadata };
          return { result: undefined, changes: { documents: { 'host/isolation.json': rows } } };
        }),
      updateStatus: (id, status, observed) =>
        commit(root, [], async () => {
          const rows = await environments();
          const row = rows.find(row => row.id === id);
          if (!row) throw new Error(`Isolation environment ${id} not found`);
          if (
            observed &&
            (row.status !== 'destroyed' ||
              !sameWorktreeRegistration(row, observed) ||
              rows.some(
                candidate =>
                  candidate.status === 'active' &&
                  candidate.codebase_id === observed.codebase_id &&
                  candidate.workflow_type === observed.workflow_type &&
                  candidate.workflow_id === observed.workflow_id
              ))
          )
            throw new WorktreeRegistrationChangedError(id);
          row.status = status;
          return { result: undefined, changes: { documents: { 'host/isolation.json': rows } } };
        }),
      markWorktreeDestroyed: observed =>
        commit(root, [], async () => {
          const rows = await environments();
          const row = rows.find(row => row.id === observed.id);
          if (!row || !sameWorktreeRegistration(row, observed)) {
            throw new WorktreeRegistrationChangedError(observed.id);
          }
          row.status = 'destroyed';
          return { result: undefined, changes: { documents: { 'host/isolation.json': rows } } };
        }),
      withWorktreeRegistration: (observed, remove) =>
        commit(root, 'all', async () => {
          const rows = await environments();
          const row = rows.find(row => row.id === observed.id);
          if (!row || row.status !== 'active' || !sameWorktreeRegistration(row, observed)) {
            throw new WorktreeRegistrationChangedError(observed.id);
          }
          const result = await remove(async () => {
            row.status = 'destroyed';
          });
          return { result, changes: { documents: { 'host/isolation.json': rows } } };
        }),
      countActiveByCodebase: async id => (await records.isolation.listByCodebase(id)).length,
      listActive: async () => (await readEnvironments()).filter(row => row.status === 'active'),
      listByCodebase: async id =>
        (await readEnvironments())
          .filter(row => row.codebase_id === id && row.status === 'active')
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
      findLatestByCodebaseAndWorkingPath: async (id, path, before) =>
        (await readEnvironments())
          .filter(
            row => row.codebase_id === id && row.working_path === path && row.created_at <= before
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
    },
  };
  const store = await createFileWorkflowStore({
    root,
    getCodebase: id => records.codebases.getCodebase(id),
    listReusableCheckouts: async () =>
      (await environments())
        .filter(row => row.status === 'active' && row.workflow_type === 'task')
        .map(row => ({
          codebaseId: row.codebase_id,
          branch: row.workflow_id,
          workingPath: row.working_path,
        })),
    isCheckoutReleased: async (run, path) => {
      const matching = (await environments()).filter(
        row =>
          row.provider === 'worktree' &&
          row.codebase_id === run.codebase_id &&
          row.working_path === (run.working_path ?? path)
      );
      return matching.length > 0 && matching.every(row => row.status !== 'active');
    },
    getCodebaseEnvVars: async id =>
      (await readCodebases()).find(row => row.id === id)?.envVars ?? {},
  });
  const worktreeReaders: WorktreeOwnershipReaders = {
    getCodebase: id => records.codebases.getCodebase(id),
    getLiveRunOwningEnv: async (id, _release, excludeRunId) => {
      const env = await records.isolation.getById(id);
      const runs = await listRuns(root);
      return (
        runs
          .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
          .find(
            row =>
              row.id !== excludeRunId &&
              (!isTerminalRunStatus(row.status) ||
                RESUMABLE_WORKFLOW_STATUSES.includes(row.status)) &&
              (row.metadata.isolation_env_id === id ||
                worktreeReferenceSchema.safeParse(row.metadata.owned_worktree).data?.envId === id ||
                (row.codebase_id === env?.codebase_id && row.working_path === env?.working_path))
          ) ?? null
      );
    },
  };
  const deps: ReturnType<typeof createWorkflowDeps> = {
    ...createWorkflowDeps(store, 'files'),
    completedRunWorktree: completedRunWorktreeDeps(async () => ({
      cleanup: await import('../services/cleanup/run-worktree'),
      store: records.isolation,
      readers: worktreeReaders,
    })),
  };
  return {
    records,
    deps,
    engine: new InProcessWorkflowEngine(deps, {
      branchOf: attentionQueueSource(store, records.isolation).branchOf,
      ownerLoss: runOwnerLossWatch(store),
    }),
    operations: createWorkflowOperations({
      store,
      hostStore: records,
      getUserRole: async () => undefined,
      requestDetachedRunStop,
      isRunOwnedByThisProcess,
      isRunOwnerAnswering,
      reclaimRunWorktree: async (run, isolation) =>
        (await import('../services/cleanup/run-worktree')).reclaimRunWorktree(
          run,
          isolation,
          worktreeReaders
        ),
      reclaimContainerEnv: async (id, isolation) =>
        (await import('../services/cleanup/containers')).reclaimContainerEnv(id, isolation),
    }),
  };
}
