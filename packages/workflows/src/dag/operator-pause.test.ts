// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '../file-store/store';
import { executeDagWorkflow } from '../dag-executor';
import { hydrateResumableRun } from '../run-resume';
import { dagNodeSchema, operatorPause, type OperatorPauseRecord } from '../schemas';
import { createMockDeps, dagOptions, mockSendQueryDag } from './test-utils';

// An operator's pause request recorded while a node runs, through a real store: the walk
// lets the running nodes finish, starts nothing after them, and a resume continues there.

const roots = trackTempRoots();
const request: OperatorPauseRecord = {
  requested: { at: new Date().toISOString(), via: 'cli', by: { declared: 'ops' }, fromRun: null },
};

async function startRun(nodes: unknown[]) {
  const root = roots(await mkdtemp(join(tmpdir(), 'operator-pause-')));
  const store = await createFileWorkflowStore({ root });
  const created = await store.createWorkflowRun({ workflow_name: 'paused', user_message: '' });
  const run = await store.claimPendingWorkflowRun(created.id, root);
  if (!run) throw new Error('Claim failed');
  const options = dagOptions({
    deps: createMockDeps(store),
    cwd: root,
    workflowRun: run,
    workflow: { name: 'paused', nodes: nodes.map(node => dagNodeSchema.parse(node)) },
  });
  // Every prompt node answers its own prompt; the first one also records the request.
  let requested = false;
  mockSendQueryDag.mockImplementation(async function* (prompt: string) {
    if (!requested) {
      requested = true;
      await store.updateWorkflowRunMetadataIfRunning(run.id, { operator_pause: request });
    }
    yield { type: 'agent_message_chunk', text: `out:${prompt}` };
    yield { type: 'result', sessionId: `s-${prompt}` };
  });
  const started = async (): Promise<string[]> =>
    (await store.listWorkflowEvents(run.id))
      .filter(event => event.event_type === 'node_started')
      .map(event => event.step_name ?? '');
  const resume = async (): Promise<void> => {
    const candidate = await store.getWorkflowRun(run.id);
    if (!candidate) throw new Error('Missing run');
    const resumed = await hydrateResumableRun({ store }, candidate);
    if (!resumed) throw new Error('Missing resume');
    await executeDagWorkflow({ ...options, ...resumed, workflowRun: resumed.preCreatedRun });
  };
  return { store, run, options, started, resume };
}

test('a pause requested during a node pauses after it, and a resume runs the next node on its output', async () => {
  const { store, run, options, started, resume } = await startRun([
    { id: 'a', prompt: 'a' },
    { id: 'b', depends_on: ['a'], bash: 'printf "got:%s" $a.output' },
  ]);

  await executeDagWorkflow(options);

  const paused = await store.getWorkflowRun(run.id);
  expect(paused?.status).toBe('paused');
  expect(paused && operatorPause(paused)).toMatchObject({
    state: 'paused',
    requested: request.requested,
    pausedAt: expect.any(String),
  });
  expect(await started()).toEqual(['a']);
  expect(
    (await store.listWorkflowEvents(run.id)).filter(e => e.event_type === 'operator_paused')
  ).toHaveLength(1);

  await resume();

  const done = await store.getWorkflowRun(run.id);
  expect(done?.status).toBe('completed');
  expect(done?.metadata.operator_pause).toBeUndefined();
  expect(await started()).toEqual(['a', 'b']);
  const b = (await store.listWorkflowEvents(run.id)).find(
    event => event.step_name === 'b' && event.event_type === 'node_completed'
  );
  expect(b?.data.node_output).toBe('got:out:a');
});

test('nodes running in parallel each finish and none after them starts', async () => {
  const { store, run, options, started } = await startRun([
    { id: 'a1', prompt: 'a1' },
    { id: 'a2', prompt: 'a2' },
    { id: 'c', depends_on: ['a1', 'a2'], bash: 'echo c' },
  ]);

  await executeDagWorkflow(options);

  expect((await store.getWorkflowRun(run.id))?.status).toBe('paused');
  expect((await started()).sort()).toEqual(['a1', 'a2']);
  const completed = (await store.listWorkflowEvents(run.id))
    .filter(event => event.event_type === 'node_completed')
    .map(event => event.step_name);
  expect(completed.sort()).toEqual(['a1', 'a2']);
});

test('a layer run one node at a time starts no node after the request', async () => {
  // A checkout-guarded node beside an unguarded one runs that layer one node at a time.
  const { store, run, options, started, resume } = await startRun([
    { id: 'a', prompt: 'a' },
    { id: 'g', bash: 'echo g', mutates_checkout: false },
  ]);

  await executeDagWorkflow(options);

  expect((await store.getWorkflowRun(run.id))?.status).toBe('paused');
  expect(await started()).toEqual(['a']);

  await resume();

  expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
  expect(await started()).toEqual(['a', 'g']);
});

test('a request recorded before the first layer starts no node', async () => {
  const { store, run, options, started, resume } = await startRun([
    { id: 'a', bash: 'echo a' },
    { id: 'b', depends_on: ['a'], bash: 'echo b' },
  ]);
  await store.updateWorkflowRunMetadataIfRunning(run.id, { operator_pause: request });

  await executeDagWorkflow(options);

  expect((await store.getWorkflowRun(run.id))?.status).toBe('paused');
  expect(await started()).toEqual([]);

  await resume();

  expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
  expect(await started()).toEqual(['a', 'b']);
});

test('a request during the last layer lets the run complete', async () => {
  const { store, run, options } = await startRun([{ id: 'a', prompt: 'a' }]);

  await executeDagWorkflow(options);

  expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
});
