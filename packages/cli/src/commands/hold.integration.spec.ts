// @archon-test-isolated
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { registerFolder } from '@archon/core/handlers/clone';
import { holdCommand } from './hold';
import { triggerCommand } from './trigger';
import { readHeldStarts } from './workflow-held-starts';
import { workflowStatusCommand } from './workflow-query';

const saved = {
  home: process.env.ARCHON_HOME,
  database: process.env.DATABASE_URL,
  user: process.env.ARCHON_USER_ID,
  triggerHost: process.env.ARCHON_TRIGGER_HOST,
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
    ['ARCHON_TRIGGER_HOST', saved.triggerHost],
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
  // The lift drains the host a trigger file on this install names, and not one named only
  // by a config kept elsewhere.
  const triggers = join(root, 'home', 'triggers');
  await mkdir(triggers, { recursive: true });
  const triggerFile = (sourceInstanceId: string, bindingId: string, hostId: string) =>
    JSON.stringify({
      version: 1,
      sourceInstanceId,
      binding: {
        bindingId,
        bindingRevision: null,
        hostId,
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
    });
  const config = join(triggers, 'timer.json');
  await writeFile(config, triggerFile('timer', 'fired', 'host'));
  const elsewhere = join(root, 'elsewhere.json');
  await writeFile(elsewhere, triggerFile('elsewhere', 'fired-elsewhere', 'other-host'));
  const dispatched: string[] = [];
  const dispatch = async (requestId: string): Promise<null> => {
    dispatched.push(requestId);
    return null;
  };

  const [set] = await jsonLines(() => holdCommand(host, 'set', { json: true }, dispatch));
  const hold = (set as { hold: { setBy: string; setAt: string } }).hold;
  expect(hold.setBy).toBe('operator');

  const [fired] = await jsonLines(() => triggerCommand(host, 'fire', [], { config }, { dispatch }));
  expect(fired).toMatchObject({ hold, bindings: [{ status: 'pending', disposition: null }] });
  const receiptId = (fired as { id: string }).id;
  const [firedElsewhere] = await jsonLines(() =>
    triggerCommand(host, 'fire', [], { config: elsewhere }, { dispatch })
  );
  const elsewhereId = (firedElsewhere as { id: string }).id;
  expect(dispatched).toEqual([]);

  // Newest receipt first.
  const [listed] = await jsonLines(() => triggerCommand(host, 'list', [], {}, { dispatch }));
  expect(listed).toEqual([
    expect.objectContaining({ id: elsewhereId, hold }),
    expect.objectContaining({ id: receiptId, hold }),
  ]);
  const [status] = await jsonLines(() =>
    workflowStatusCommand(host, project, { json: true, all: true })
  );
  expect(status).toMatchObject({
    hold,
    heldStarts: [
      { kind: 'trigger', receiptId, bindingId: 'fired', workflow: 'portable' },
      { kind: 'trigger', receiptId: elsewhereId, bindingId: 'fired-elsewhere' },
    ],
  });

  const [heldDrain] = await jsonLines(() =>
    triggerCommand(host, 'drain', [], { host: 'host' }, { dispatch })
  );
  expect(heldDrain).toEqual({ hostId: 'host', drained: false, hold });
  expect(dispatched).toEqual([]);

  // A host named only by ARCHON_TRIGGER_HOST is not one this install drains.
  process.env.ARCHON_TRIGGER_HOST = 'other-host';
  const [lifted] = await jsonLines(() => holdCommand(host, 'lift', { json: true }, dispatch));
  expect(lifted).toEqual({
    lifted: hold,
    drainedHosts: ['host'],
    failures: [],
    elsewhere: ['other-host'],
  });
  const [after] = await jsonLines(() => triggerCommand(host, 'list', [], {}, { dispatch }));
  expect(after).toEqual([
    expect.objectContaining({ id: elsewhereId, hold: null }),
    expect.objectContaining({ id: receiptId, hold: null }),
  ]);
  // Another machine's start stays for that machine's drain.
  expect((await host.deps.store.getStartReceipt(elsewhereId))?.bindings[0]?.status).toBe('pending');
  await jsonLines(() => triggerCommand(host, 'drain', [], { host: 'host' }, { dispatch }));
  const disposition = (await host.deps.store.getStartReceipt(receiptId))?.bindings[0]?.disposition;
  if (disposition?.status !== 'admitted') throw new Error('Expected the held start to be admitted');
  expect(dispatched).toEqual([disposition.requestId]);
});

test('the oldest held hand start is listed behind more newer pending runs than one read returns', async () => {
  const host = createSqlWorkflowHost();
  const store = host.deps.store;
  const hand = await store.createWorkflowRun({ workflow_name: 'oldest', user_message: '' });
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET started_at = datetime('now', '-1 hour') WHERE id = $1",
    [hand.id]
  );
  const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
  await store.claimPendingWorkflowRun(parent.id);
  for (let index = 0; index < 400; index++)
    await store.createWorkflowRun({
      workflow_name: 'child',
      user_message: '',
      parent_run_id: parent.id,
    });
  const { hold } = await store.setInstallHold({ setBy: 'operator' });

  expect(await readHeldStarts(host, undefined)).toEqual({
    hold,
    heldStarts: [{ kind: 'run', runId: hand.id, workflow: 'oldest' }],
  });
});
