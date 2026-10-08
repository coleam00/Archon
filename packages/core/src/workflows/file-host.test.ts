import { afterEach, expect, expectTypeOf, test } from 'bun:test';
import type { z } from 'zod';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { toBranchName } from '@archon/git';
import { createFileWorkflowHost, isolationSchema } from './file-host';
import { FileStoreUnsupportedError, commit } from '@archon/workflows/file-store';
const roots = trackTempRoots();
const prior = { ...process.env };
afterEach(() => {
  process.env = { ...prior };
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
  expect(await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator')).toBeNull();
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
  });
  const upsert = await host.records.isolation.create({
    ...env,
    created_by_platform: env.created_by_platform ?? undefined,
    branch_name: toBranchName('other'),
    created_by_user_id: 'second',
  });
  expect(upsert.id).toBe(env.id);
  expect(upsert.created_by_user_id).toBe('first');
  const reopened = await createFileWorkflowHost(root);
  expect(await reopened.deps.store.getCodebaseEnvVars(codebase.id)).toEqual({
    FILE_SETTING: 'value',
  });
  expect(
    await reopened.records.codebases.findCodebaseByPathPrefix(join(home, 'nested'))
  ).toMatchObject({ id: codebase.id, commands: { test: { path: 'test.md' } } });
  expect(await reopened.records.isolation.getById(env.id)).toMatchObject({
    id: env.id,
    branch_name: 'other',
    created_at: expect.any(Date),
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
