// @archon-test-isolated
/**
 * A start a run's end or settled asks caused, waiting while its trigger file is registered
 * again, follows the file's start config: rebuilt when it is prepared, or taken from its
 * queue and prepared again. A file removed while its host's trigger directory still names
 * the host refuses it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import type { ItemAsk } from '@archon/workflows/schemas/item-ask';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import {
  readWorkflowRunConfigMetadata,
  WORKFLOW_RUN_CONFIG_METADATA_KEY,
} from '@archon/workflows/run-config';
import { readWorkflowSourceState } from '@archon/workflows/schemas/run-metadata';
import { sealWorkflowRunConfig, unsealWorkflowRunConfig } from '../config/run-config';
import { closeDatabase, getDatabase, resetDatabase } from '../db/connection';
import * as codebaseDb from '../db/codebases';
import { registerFolder } from '../handlers/clone';
import { setPlatformPolicies } from '../platforms/registry';
import { registeredProjectKeyForPath } from '../services/codebase-checkout-resolver';
import { drainResourceStartHost } from './resource-start-host';
import { createRunEndedStarts, getTriggersPath, launchProjectKey } from './run-ended';
import { createSqlWorkflowHost } from './sql-host';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root = '';
let project = '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-rebuilt-binding-')));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  registerBuiltinProviders();
  setPlatformPolicies([]);
  await getDatabase().query(
    `INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')`,
    [USER_ID]
  );
  project = join(root, 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
});

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

/** The started stage, declaring `inputs` (each required). */
async function stage(inputs: string[]): Promise<void> {
  const declared = inputs.length
    ? `inputs:\n${inputs.map(name => `  ${name}: { required: true }\n`).join('')}`
    : '';
  await writeFile(
    join(project, '.archon/workflows/stage-b.yaml'),
    `name: stage-b\ndescription: B\n${declared}worktree:\n  enabled: false\nnodes:\n  - id: b\n    bash: echo b\n`
  );
}

/** The trigger file starting stage-b, with `on` and `capacity` as given. */
async function trigger(
  on: Record<string, unknown>,
  capacity = 5,
  source = 'stage-b',
  where: { file?: string; hostId?: string } = {}
): Promise<void> {
  await mkdir(getTriggersPath(), { recursive: true });
  await writeFile(
    join(getTriggersPath(), where.file ?? `${source}.json`),
    JSON.stringify({
      version: 1,
      sourceInstanceId: source,
      binding: {
        bindingId: source,
        bindingRevision: null,
        hostId: where.hostId ?? 'host',
        runAsUserId: USER_ID,
        resource: 'pool',
        capacity,
        overlap: 'queue',
        launch: {
          cwd: project,
          workflowName: 'stage-b',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
      on,
    })
  );
}

const afterA = (inputs: Record<string, unknown>) => ({
  runEnded: { workflowName: 'stage-a', outcome: 'done', inputs },
});

async function setup() {
  const host = createSqlWorkflowHost();
  const store = host.deps.store;
  const { codebaseId } = await registerFolder(host.records.codebases, project, 'project');
  const started: string[] = [];
  const pass = () =>
    drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        started.push(id);
        return null;
      },
    });
  const runs = { codebase_id: codebaseId, user_message: '', item_key: 'issue-1' };
  const projectKeyOf = launchProjectKey(cwd => registeredProjectKeyForPath(cwd, codebaseDb));
  const onDeps = {
    triggersDirectory: getTriggersPath,
    getItem: store.getItem.bind(store),
    projectKeyOf,
  };
  return { host, store, codebaseId, started, pass, runs, onDeps };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A completed run of stage-a on issue-1 given `issue`, and the receipt its end writes. */
async function endA(
  { store, runs, onDeps }: Setup,
  issue: string,
  metadata: Record<string, unknown> = {},
  asks: readonly ItemAsk[] = []
): Promise<string> {
  const run = await store.createWorkflowRun({
    ...runs,
    workflow_name: 'stage-a',
    metadata: { inputs: { issue }, ...metadata },
  });
  await store.claimPendingWorkflowRun(run.id);
  await store.completeWorkflowRun(
    run.id,
    { duration_ms: 1 },
    undefined,
    asks.length > 0 ? { asks } : undefined
  );
  const ended = await store.getWorkflowRun(run.id);
  if (!ended) throw new Error('run missing');
  const starts = await createRunEndedStarts({
    ...onDeps,
    endedCheckout: () => Promise.reject(new Error('no checkout here')),
    listItemAsks: () => Promise.reject(new Error('no answers here')),
  })({
    run: ended,
    declaredInputs: ['issue'],
    outcomeForm: { kind: 'enum', values: ['done'] },
    outcome: { kind: 'enum', value: 'done' },
    result: undefined,
    inputs: { issue },
  });
  const [receipt] = starts.receipts;
  if (!receipt) throw new Error('no start matched');
  return (await store.acceptStartReceipt(receipt)).receiptId;
}

async function startedInputs({ store }: Setup, receiptId: string) {
  const [binding, ...others] = (await store.getStartReceipt(receiptId))?.bindings ?? [];
  expect(others).toEqual([]);
  const requestId = binding?.disposition?.requestId;
  const run = requestId ? await store.getWorkflowRun(requestId) : null;
  return { status: binding?.disposition?.status, inputs: run?.metadata.inputs };
}

test('a pending start whose trigger file dropped an input starts with the inputs the file maps now', async () => {
  const setupped = await setup();
  await stage(['issue']);
  await trigger(afterA({ issue: { input: 'issue' } }));
  const receiptId = await endA(setupped, 'Fix the login page');

  await stage(['task']);
  await trigger(afterA({ task: { input: 'issue' } }));
  await setupped.pass();

  expect(await startedInputs(setupped, receiptId)).toEqual({
    status: 'admitted',
    inputs: { task: 'Fix the login page' },
  });
});

test('an unchanged trigger file starts the start as its receipt froze it', async () => {
  const setupped = await setup();
  await stage(['issue']);
  await trigger(afterA({ issue: { input: 'issue' } }));
  const receiptId = await endA(setupped, 'Fix the login page');
  // What the run recorded changes; the file does not, so nothing is read again.
  await getDatabase().query(
    `UPDATE remote_agent_workflow_runs SET metadata = $1 WHERE workflow_name = 'stage-a'`,
    [JSON.stringify({ inputs: { issue: 'something else' } })]
  );
  await setupped.pass();

  expect(await startedInputs(setupped, receiptId)).toEqual({
    status: 'admitted',
    inputs: { issue: 'Fix the login page' },
  });
});

/** Fill the capacity-1 `pool` with a holder, and the release that frees it. */
async function holdPool({ store, codebaseId }: Setup): Promise<() => Promise<void>> {
  const holder: PreparedWorkflowLaunch = {
    version: 2,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'holder',
      codebase_id: codebaseId,
      user_message: '',
      metadata: {},
    },
    execution: { cwd: project, conversationId: 'holder', isolation: { kind: 'in-place' } },
  };
  await store.admitResourceStart({
    resource: 'pool',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: holder,
  });
  return async () => {
    await store.claimPendingWorkflowRun(holder.run.id);
    await store.completeWorkflowRun(holder.run.id, { duration_ms: 1 });
  };
}

/** A start of stage-b queued behind the held pool, prepared from the file mapping `issue`. */
async function queueB(setupped: Setup, metadata: Record<string, unknown> = {}) {
  await stage(['issue']);
  await trigger(afterA({ issue: { input: 'issue' } }), 1);
  const release = await holdPool(setupped);
  const receiptId = await endA(setupped, 'Fix the login page', metadata);
  await setupped.pass();
  const [binding] = (await setupped.store.getStartReceipt(receiptId))?.bindings ?? [];
  expect(binding?.disposition?.status).toBe('queued');
  return { receiptId, release, requestId: String(binding?.disposition?.requestId) };
}

const stageRuns = async () =>
  (
    await getDatabase().query<{ id: string }>(
      "SELECT id FROM remote_agent_workflow_runs WHERE workflow_name = 'stage-b'"
    )
  ).rows.map(row => row.id);

test("a queued start whose trigger file changed leaves the queue and starts once, with the new inputs and its item's run config", async () => {
  const setupped = await setup();
  const config = sealWorkflowRunConfig({ docsPath: 'docs/stage' }, { kind: 'cli', label: 'test' });
  const { receiptId, release, requestId } = await queueB(setupped, {
    [WORKFLOW_RUN_CONFIG_METADATA_KEY]: config,
  });

  await stage(['task']);
  await trigger(afterA({ task: { input: 'issue' } }), 1);
  await release();
  await setupped.pass();

  const admitted = await startedInputs(setupped, receiptId);
  expect(admitted).toEqual({ status: 'admitted', inputs: { task: 'Fix the login page' } });
  const runs = await stageRuns();
  expect(runs).toHaveLength(1);
  expect(setupped.started).toEqual(runs);
  const run = await setupped.store.getWorkflowRun(String(runs[0]));
  const sealed = readWorkflowRunConfigMetadata(run?.metadata);
  expect(sealed && unsealWorkflowRunConfig(sealed).docsPath).toBe('docs/stage');
  // The request it left stays inspectable.
  expect((await setupped.store.getResourceStartRequest(requestId))?.status).toBe('withdrawn');
});

/** Give the receipt the revision an older Archon recorded: a hash of the file's binding alone. */
async function olderRevision(receiptId: string): Promise<void> {
  const file = JSON.parse(await readFile(join(getTriggersPath(), 'stage-b.json'), 'utf8'));
  await setRevision(
    receiptId,
    createHash('sha256').update(JSON.stringify(file.binding)).digest('hex')
  );
}

const setRevision = (receiptId: string, revision: string | null) =>
  getDatabase().query(
    'UPDATE remote_agent_start_receipt_bindings SET binding_revision = $1 WHERE receipt_id = $2',
    [revision, receiptId]
  );

test.each(['before this release', 'now'])(
  'a queued start whose receipt recorded its revision %s runs as prepared, on its captured source, when only its workflow changed',
  async format => {
    const setupped = await setup();
    const { receiptId, release, requestId } = await queueB(setupped);
    if (format === 'before this release') await olderRevision(receiptId);
    await stage([]);
    await release();
    await setupped.pass();

    expect(await startedInputs(setupped, receiptId)).toEqual({
      status: 'admitted',
      inputs: { issue: 'Fix the login page' },
    });
    expect(setupped.started).toEqual([requestId]);
    const source = readWorkflowSourceState(
      (await setupped.store.getWorkflowRun(requestId))?.metadata
    );
    expect(source.kind === 'recorded' && existsSync(source.record.root)).toBe(true);
  }
);

test('a queued start whose receipt an older Archon wrote follows a mapping-only change', async () => {
  const setupped = await setup();
  const { receiptId, release } = await queueB(setupped);
  await olderRevision(receiptId);
  await stage(['task']);
  await trigger(afterA({ task: { input: 'issue' } }), 1);
  await release();
  await setupped.pass();

  expect(await startedInputs(setupped, receiptId)).toEqual({
    status: 'admitted',
    inputs: { task: 'Fix the login page' },
  });
  expect(await stageRuns()).toHaveLength(1);
});

test('a pending start whose file was removed, while its host is still named, is refused on its item', async () => {
  const setupped = await setup();
  await stage(['issue']);
  await trigger(afterA({ issue: { input: 'issue' } }));
  const receiptId = await endA(setupped, 'Fix the login page');
  // Another source on the same host, so this home is still the host's registry.
  await trigger(afterA({}), 5, 'other-stage');
  await rm(join(getTriggersPath(), 'stage-b.json'));
  await setupped.pass();

  expect(await stageRuns()).toEqual([]);
  expect((await setupped.store.getStartReceipt(receiptId))?.bindings[0]?.status).toBe('rejected');
  const ended = (
    await getDatabase().query<{ metadata: string }>(
      "SELECT metadata FROM remote_agent_workflow_runs WHERE workflow_name = 'stage-a'"
    )
  ).rows[0];
  expect(JSON.parse(String(ended?.metadata)).item_stopped).toMatchObject({
    refused: [{ workflow: 'stage-b', reason: 'launch_preparation_failed' }],
  });
});

test('an unreadable trigger file of another source does not affect a start whose own file is found', async () => {
  const setupped = await setup();
  const { receiptId, release } = await queueB(setupped);
  await stage(['task']);
  await trigger(afterA({ task: { input: 'issue' } }), 1);
  await writeFile(join(getTriggersPath(), 'broken.json'), '{ not json');
  await release();
  await setupped.pass();

  expect(await startedInputs(setupped, receiptId)).toEqual({
    status: 'admitted',
    inputs: { task: 'Fix the login page' },
  });
});

const askOf = (question: string): ItemAsk => ({
  question,
  context: 'Two ways to go.',
  options: [
    { id: 'keep', does: 'Keep it.', cost: 'More to keep.' },
    { id: 'drop', does: 'Drop it.', cost: 'Configs break.' },
  ],
  recommendation: { option: 'keep', why: 'Nothing depends on dropping it.' },
  artifacts: [],
});

test('a pending start of settled asks is rebuilt from the answers when its file changed', async () => {
  const setupped = await setup();
  const { store, runs } = setupped;
  await stage(['notes']);
  const settled = (inputs: Record<string, unknown>) => ({
    asksSettled: { workflowName: 'plan', settled: 'any', inputs },
  });
  await trigger(settled({ notes: { answers: true } }));
  const run = await store.createWorkflowRun({ ...runs, workflow_name: 'plan' });
  await store.claimPendingWorkflowRun(run.id);
  await store.completeWorkflowRun(run.id, { duration_ms: 1 }, undefined, {
    asks: [askOf('Keep the flag?')],
  });
  const [ask] = await store.listItemAsks(String(run.item_id));
  if (!ask || !('id' in ask)) throw new Error('no ask');
  // The close writes the start its settlement causes, from the file as it is now.
  const closed = await store.withdrawItemAsk({
    askId: ask.id,
    via: 'cli',
    by: { declared: 'maintainer' },
    fromRun: null,
  });
  const receiptId = closed.kind === 'closed' ? closed.startReceipts[0]?.receipt.id : undefined;
  if (!receiptId) throw new Error(`the settlement started nothing: ${JSON.stringify(closed)}`);

  await stage(['decision']);
  await trigger(settled({ decision: { answers: true } }));
  await setupped.pass();

  const { status, inputs } = await startedInputs(setupped, receiptId);
  expect(status).toBe('admitted');
  expect(inputs).toMatchObject({ decision: expect.stringContaining('Keep the flag?') });
});
