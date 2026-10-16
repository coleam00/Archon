import { afterEach, expect, expectTypeOf, spyOn, test } from 'bun:test';
import type { z } from 'zod';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import * as fs from 'node:fs/promises';
import { registerWorktree } from '@archon/isolation';
import { toRepoPath, toWorktreePath } from '@archon/git';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { toBranchName } from '@archon/git';
import { createFileWorkflowHost, isolationSchema } from './file-host';
import { FileStoreUnsupportedError, commit } from '@archon/workflows/file-store';
const roots = trackTempRoots();
// Restore the keys in place: assigning a new object to process.env drops
// Bun's case-insensitive Windows env, so later files read PATH as undefined.
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID'].map(key => [key, process.env[key]])
);
afterEach(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('file isolation records conform to the isolation store row', () => {
  expectTypeOf<z.output<typeof isolationSchema>[number]>().toEqualTypeOf<IsolationEnvironmentRow>();
});
test('file host records persist across hosts and released worktrees fence pending claims', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-host-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const root = join(home, 'store');
  const host = await createFileWorkflowHost(root);
  const codebase = await host.records.codebases.createCodebase({
    name: 'project',
    default_cwd: home,
  });
  const widerInput = {
    default_cwd: join(home, 'checkout'),
    repository_url: 'https://example.test/repo',
    default_branch: 'main',
    kind: 'folder' as const,
  };
  await host.records.codebases.updateCodebase(codebase, widerInput);
  expect(await host.records.codebases.getCodebase(codebase.id)).toMatchObject({
    ...widerInput,
    kind: 'repo',
  });
  await host.records.codebases.updateCodebase(codebase, {
    default_cwd: undefined,
    repository_url: null,
    default_branch: null,
  });
  expect(await host.records.codebases.getCodebase(codebase.id)).toMatchObject({
    default_cwd: widerInput.default_cwd,
    repository_url: null,
    default_branch: null,
    kind: 'repo',
  });
  const user = await host.records.users.findOrCreateUserByPlatformIdentity(
    'cli',
    'operator',
    'Operator'
  );
  expect(user).toMatchObject({ display_name: 'Operator' });
  expect(await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator')).toEqual(
    user
  );
  await expect(
    host.records.conversations.getConversationById('conversation')
  ).rejects.toBeInstanceOf(FileStoreUnsupportedError);
  await host.records.codebases.updateCodebaseCommands(codebase.id, {
    test: { path: 'test.md', description: 'Test' },
  });
  await commit(root, [], async () => ({
    result: undefined,
    changes: {
      documents: {
        'host/codebases.json': [
          {
            ...codebase,
            commands: { test: { path: 'test.md', description: 'Test' } },
            envVars: { FILE_SETTING: 'value' },
          },
        ],
      },
    },
  }));
  const env = await host.records.isolation.create({
    codebase_id: codebase.id,
    workflow_type: 'task',
    workflow_id: 'run',
    working_path: join(home, 'checkout'),
    branch_name: toBranchName('feature'),
    created_by_user_id: 'first',
    metadata: { worktree_creation_id: 'proof', worktree_branch_created: true, adopted: false },
  });
  const upsert = await host.records.isolation.create({
    ...env,
    created_by_platform: env.created_by_platform ?? undefined,
    branch_name: toBranchName('other'),
    created_by_user_id: 'second',
  });
  expect(upsert.id).toBe(env.id);
  expect(upsert.created_by_user_id).toBe('first');
  await host.records.isolation.updateMetadata(upsert.id, { adopted: true });
  const reopened = await createFileWorkflowHost(root);
  expect(await reopened.records.users.getUserById(user!.id)).toEqual(user);
  expect(await reopened.deps.store.getCodebaseEnvVars(codebase.id)).toEqual({
    FILE_SETTING: 'value',
  });
  expect(
    await reopened.records.codebases.findCodebaseByPathPrefix(join(home, 'nested'))
  ).toMatchObject({ id: codebase.id, commands: { test: { path: 'test.md' } } });
  expect(await reopened.records.isolation.getById(env.id)).toMatchObject({
    id: env.id,
    branch_name: 'other',
    created_at: upsert.created_at,
    metadata: { worktree_creation_id: 'proof', worktree_branch_created: true, adopted: true },
  });
  expect(await reopened.records.isolation.countActiveByCodebase(codebase.id)).toBe(1);
  await reopened.records.isolation.updateStatus(env.id, 'destroyed');
  const run = await reopened.deps.store.createWorkflowRun({
    workflow_name: 'test',
    user_message: '',
    codebase_id: codebase.id,
    working_path: env.working_path,
  });
  expect(await reopened.deps.store.claimPendingWorkflowRun(run.id)).toBeNull();
  const recreated = await reopened.records.isolation.create({
    ...env,
    created_by_platform: env.created_by_platform ?? undefined,
    created_by_user_id: env.created_by_user_id ?? undefined,
    branch_name: toBranchName(env.branch_name),
  });
  expect(recreated.id).not.toBe(env.id);
  expect(await reopened.deps.store.claimPendingWorkflowRun(run.id)).toMatchObject({
    status: 'running',
  });
});

test('file adoption metadata refuses a replaced registration, including the same path', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-adoption-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const host = await createFileWorkflowHost(join(home, 'store'));
  const store = host.records.isolation;
  const input = {
    codebase_id: 'cb',
    workflow_type: 'task' as const,
    workflow_id: 'run',
    working_path: home,
    branch_name: toBranchName('task'),
  };
  for (const path of [home, join(home, 'other')]) {
    const observed = await store.create(input);
    const replacement = await store.create({ ...input, working_path: path });
    await expect(store.updateMetadata(observed.id, { adopted: true }, observed)).rejects.toThrow(
      'changed during adoption'
    );
    expect(await store.getById(observed.id)).toEqual(replacement);
    await store.updateMetadata(replacement.id, { adopted: true }, replacement);
    expect((await store.getById(replacement.id))?.metadata.adopted).toBe(true);
  }
});

test('file host retires only the observed worktree registration', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'file-retire-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const store = (await createFileWorkflowHost(join(home, 'store'))).records.isolation;
  const input = {
    codebase_id: 'cb',
    workflow_type: 'task' as const,
    workflow_id: 'run',
    working_path: home,
    branch_name: toBranchName('task'),
  };
  const observed = await store.create(input);
  const replacement = await store.create(input);
  expect(replacement.id).toBe(observed.id);
  await expect(store.markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
  expect(await store.getById(observed.id)).toEqual(replacement);
  await store.markWorktreeDestroyed(replacement);
  expect((await store.getById(replacement.id))?.status).toBe('destroyed');
  await store.markWorktreeDestroyed(replacement);
  const destroyed = (await store.getById(replacement.id))!;
  await store.markWorktreeDestroyed(destroyed);
  expect(await store.getById(replacement.id)).toEqual(destroyed);
  await expect(store.markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
  await expect(store.updateMetadata(destroyed.id, { adopted: true }, destroyed)).rejects.toThrow(
    'changed during adoption'
  );
});

test('file host refuses legacy tokenless replacements within its atomic adoption write', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'legacy-adoption-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const root = join(home, 'store');
  const {
    records: { isolation: store },
  } = await createFileWorkflowHost(root);
  const created = await store.create({
    codebase_id: 'cb',
    workflow_type: 'task',
    workflow_id: 'run',
    working_path: home,
    branch_name: toBranchName('task'),
  });
  const observed = { ...created, metadata: {} };
  for (const replacement of [
    { ...observed, working_path: join(home, 'other') },
    { ...observed, branch_name: 'other' },
    { ...observed, created_at: new Date(0) },
    { ...observed, metadata: { legacy: true } },
  ]) {
    await commit(root, [], async () => ({
      result: undefined,
      changes: { documents: { 'host/isolation.json': [replacement] } },
    }));
    await expect(store.updateMetadata(observed.id, { adopted: true }, observed)).rejects.toThrow(
      'changed during adoption'
    );
    expect(await store.getById(created.id)).toEqual(replacement);
    await store.updateMetadata(replacement.id, { adopted: true }, replacement);
  }
});

test('file host retirement is idempotent for a legacy registration and fences replacements', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'legacy-retire-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  const root = join(home, 'store');
  const store = (await createFileWorkflowHost(root)).records.isolation;
  const created = await store.create({
    codebase_id: 'cb',
    workflow_type: 'task',
    workflow_id: 'run',
    working_path: home,
    branch_name: toBranchName('task'),
  });
  const observed = { ...created, metadata: {} };
  await commit(root, [], async () => ({
    result: undefined,
    changes: { documents: { 'host/isolation.json': [observed] } },
  }));
  await store.markWorktreeDestroyed(observed);
  const destroyed = (await store.getById(observed.id))!;
  await store.markWorktreeDestroyed(observed);
  await store.markWorktreeDestroyed(destroyed);
  expect(await store.getById(observed.id)).toEqual(destroyed);
  await expect(store.updateMetadata(destroyed.id, { adopted: true }, destroyed)).rejects.toThrow(
    'changed during adoption'
  );
  const replacement = { ...destroyed, metadata: { replaced: true } };
  await commit(root, [], async () => ({
    result: undefined,
    changes: { documents: { 'host/isolation.json': [replacement] } },
  }));
  await expect(store.markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
  expect(await store.getById(observed.id)).toEqual(replacement);
});

for (const persistent of [false, true]) {
  test(`registration preserves a created checkout after a ${persistent ? 'persistent' : 'transient'} file finalization failure`, async () => {
    const home = roots(await mkdtemp(join(tmpdir(), 'file-create-failure-')));
    process.env.ARCHON_HOME = home;
    process.env.DATABASE_URL = '';
    process.env.GITHUB_APP_ID = '';
    const root = join(home, 'store');
    const host = await createFileWorkflowHost(root);
    const checkout = join(home, 'checkout');
    await fs.mkdir(checkout);
    const failure = Object.assign(new Error('head write failed'), { code: 'EIO' });
    const open = fs.open;
    let failed = false;
    const fault = spyOn(fs, 'open').mockImplementation((...args) => {
      if (String(args[0]).startsWith(join(root, 'head.json.')) && (persistent || !failed)) {
        failed = true;
        return Promise.reject(failure);
      }
      return open(...args);
    });
    let removed = false;
    try {
      await expect(
        registerWorktree(
          {
            store: host.records.isolation,
            provider: {
              destroy: async () => {
                removed = true;
                await fs.rm(checkout, { recursive: true });
                return {
                  worktreeRemoved: true,
                  directoryClean: true,
                  branchDeleted: false,
                  remoteBranchDeleted: false,
                  warnings: [],
                };
              },
            },
          },
          {
            id: 'checkout',
            provider: 'worktree',
            workingPath: toWorktreePath(checkout),
            branchName: toBranchName('task'),
            status: 'active',
            createdAt: new Date(),
            metadata: {
              provenance: 'created',
              creationId: 'proof',
              branchCreated: true,
              adopted: false,
            },
          },
          toRepoPath(home),
          {
            codebase_id: 'cb',
            workflow_type: 'task',
            workflow_id: 'run',
          }
        )
      ).rejects.toBe(failure);
      expect(
        JSON.parse(await fs.readFile(join(root, 'host/isolation.json'), 'utf8'))
      ).toMatchObject([{ status: 'active', working_path: checkout }]);
    } finally {
      fault.mockRestore();
    }
    expect(removed).toBe(false);
    const recovered = await createFileWorkflowHost(root);
    expect(
      await recovered.records.isolation.findActiveByWorkflow('cb', 'task', 'run')
    ).toMatchObject({ working_path: checkout });
    expect((await fs.stat(checkout)).isDirectory()).toBe(true);
  });
}
