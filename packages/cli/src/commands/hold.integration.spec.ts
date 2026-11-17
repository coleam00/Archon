// @archon-test-isolated
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { closeDatabase, resetDatabase } from '@archon/core/db/connection';
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { registerFolder } from '@archon/core/handlers/clone';
import { holdCommand } from './hold';
import { triggerCommand } from './trigger';
import { workflowStatusCommand } from './workflow-query';

const saved = {
  home: process.env.ARCHON_HOME,
  database: process.env.DATABASE_URL,
  user: process.env.ARCHON_USER_ID,
};
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-hold-'));
  process.env.ARCHON_HOME = join(root, 'home');
  process.env.ARCHON_USER_ID = 'operator';
  delete process.env.DATABASE_URL;
  resetDatabase();
});

afterEach(async () => {
  await closeDatabase();
  for (const [key, value] of [
    ['ARCHON_HOME', saved.home],
    ['DATABASE_URL', saved.database],
    ['ARCHON_USER_ID', saved.user],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempTree(root);
});

/** Run `call` and return each JSON document it wrote to stdout. */
async function jsonLines(call: () => Promise<unknown>): Promise<unknown[]> {
  const chunks: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    callback?: () => void
  ) => {
    chunks.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await call();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  // `writeJsonLine` writes each document whole, pretty-printed; log records share the stream.
  return chunks
    .map(chunk => JSON.parse(chunk) as unknown)
    .filter(doc => !(typeof doc === 'object' && doc !== null && 'level' in doc && 'msg' in doc));
}

test('a fire under the hold is listed as held and starts exactly once after the lift', async () => {
  registerBuiltinProviders();
  setPlatformPolicies([]);
  const project = join(await realpath(root), 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon/workflows/portable.yaml'),
    'name: portable\ndescription: Held\nworktree:\n  enabled: false\nnodes:\n  - id: a\n    bash: echo done\n'
  );
  const host = createSqlWorkflowHost();
  await registerFolder(host.records.codebases, project, 'portable');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  if (!user) throw new Error('Expected test identity');
  const config = join(root, 'timer.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      sourceInstanceId: 'timer',
      binding: {
        bindingId: 'fired',
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: user.id,
        resource: 'portable',
        capacity: 1,
        overlap: 'skip',
        launch: {
          cwd: project,
          workflowName: 'portable',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
    })
  );
  const dispatched: string[] = [];
  const dispatch = async (requestId: string): Promise<void> => {
    dispatched.push(requestId);
  };

  const [set] = await jsonLines(() => holdCommand(host, 'set', { json: true }, dispatch));
  const hold = (set as { hold: { setBy: string; setAt: string } }).hold;
  expect(hold.setBy).toBe('operator');

  const [fired] = await jsonLines(() => triggerCommand(host, 'fire', [], { config }, { dispatch }));
  expect(fired).toMatchObject({ hold, bindings: [{ status: 'pending', disposition: null }] });
  const receiptId = (fired as { id: string }).id;
  expect(dispatched).toEqual([]);

  const [listed] = await jsonLines(() => triggerCommand(host, 'list', [], {}, { dispatch }));
  expect(listed).toEqual([expect.objectContaining({ id: receiptId, hold })]);
  const [status] = await jsonLines(() =>
    workflowStatusCommand(host, project, { json: true, all: true })
  );
  expect(status).toMatchObject({
    hold,
    heldStarts: [{ kind: 'trigger', receiptId, bindingId: 'fired', workflow: 'portable' }],
  });

  const [lifted] = await jsonLines(() => holdCommand(host, 'lift', { json: true }, dispatch));
  expect(lifted).toEqual({ lifted: hold, drainedHosts: ['host'], failures: [] });
  const [after] = await jsonLines(() => triggerCommand(host, 'list', [], {}, { dispatch }));
  expect(after).toEqual([expect.objectContaining({ id: receiptId, hold: null })]);
  await jsonLines(() => triggerCommand(host, 'drain', [], { host: 'host' }, { dispatch }));
  const disposition = (await host.deps.store.getStartReceipt(receiptId))?.bindings[0]?.disposition;
  if (disposition?.status !== 'admitted') throw new Error('Expected the held start to be admitted');
  expect(dispatched).toEqual([disposition.requestId]);
});
