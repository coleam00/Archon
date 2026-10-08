import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { captureCodebaseRegistered, isPathInside } from '@archon/paths';
import {
  createFileWorkflowStore,
  commit,
  readJson,
  recoverBeforeRead,
  FileStoreUnsupportedError,
} from '@archon/workflows/file-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { codebaseRowSchema, type Codebase } from '../schemas/codebase';
import { assertAbsoluteDefaultCwd } from '../db/codebase-path';
import type { IWorkflowHostStore, WorkflowHost } from './host-store';
import { assertFileStoreConfiguration } from '../config/store-selection';
import { createWorkflowDeps } from './store-adapter';
import { createWorkflowOperations } from '../operations/workflow-operations';
import { requestDetachedRunStop } from '../services/run-owner-stop';
import { isRunOwnedByThisProcess, isRunOwnerAnswering } from '../services/run-live-owner';

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
    workflow_type: z.enum(['issue', 'pr', 'review', 'thread', 'task']),
    workflow_id: z.string(),
    provider: z.enum(['worktree', 'container', 'vm', 'remote']),
    working_path: z.string(),
    branch_name: z.string(),
    status: z.enum(['active', 'destroyed']),
    created_at: z.coerce.date(),
    created_by_platform: z.string().nullable(),
    created_by_user_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
);
export async function createFileWorkflowHost(root: string): Promise<WorkflowHost> {
  await assertFileStoreConfiguration();
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
      findCodebaseByRepoUrl: async url =>
        (await readPublicCodebases()).find(row => row.repository_url === url) ?? null,
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
        await commit(root, [], async () => ({
          result: undefined,
          changes: { documents: { 'host/codebases.json': [...(await codebases()), row] } },
        }));
        captureCodebaseRegistered();
        return codebaseRowSchema.parse(row);
      },
      updateCodebase: (target, input) =>
        updateCodebase(target.id, row => Object.assign(row, input)),
      getCodebaseCommands: async id => (await records.codebases.getCodebase(id))?.commands ?? {},
      updateCodebaseCommands: (id, commands) =>
        updateCodebase(id, row => {
          row.commands = commands;
        }),
    },
    users: { getUserById: async () => null, findOrCreateUserByPlatformIdentity: async () => null },
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
            metadata: input.metadata ?? {},
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
      updateStatus: (id, status) =>
        commit(root, [], async () => {
          const rows = await environments();
          const row = rows.find(row => row.id === id);
          if (!row) throw new Error(`Isolation environment ${id} not found`);
          row.status = status;
          return { result: undefined, changes: { documents: { 'host/isolation.json': rows } } };
        }),
      countActiveByCodebase: async id => (await records.isolation.listByCodebase(id)).length,
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
  const deps = createWorkflowDeps(store, 'files');
  return {
    records,
    deps,
    engine: new InProcessWorkflowEngine(deps),
    operations: createWorkflowOperations({
      store,
      hostStore: records,
      getUserRole: async () => undefined,
      requestDetachedRunStop,
      isRunOwnedByThisProcess,
      isRunOwnerAnswering,
      reclaimRunWorktree: async (run, isolation) =>
        (await import('../services/cleanup-service')).reclaimRunWorktree(run, isolation),
      reclaimContainerEnv: async (id, isolation) =>
        (await import('../services/cleanup-service')).reclaimContainerEnv(id, isolation),
    }),
  };
}
