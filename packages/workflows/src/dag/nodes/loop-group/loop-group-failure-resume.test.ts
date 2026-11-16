// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { hydrateResumableRun } from '../../../run-resume';
import { readNodeRecordEvent } from '../../../node-record-reader';
import { dagNodeSchema } from '../../../schemas';
import { createMockDeps, dagOptions } from '../../test-utils';

// `count` numbers every body run in a counter file; `check` fails once, in round two,
// when `fail_once` is set. Resume must continue in that round, not start over.
function roundsGroup(group: Record<string, unknown>, failOnce: boolean): unknown {
  return {
    id: 'rounds',
    loop_group: {
      max_iterations: 3,
      until_bash: 'exit 1',
      ...group,
      nodes: [
        {
          id: 'count',
          bash: 'n=$(( $(cat counter 2>/dev/null || echo 0) + 1 )); echo $n > counter; echo "run=$n prev=[$LOOP_PREV.check.output]"',
        },
        {
          id: 'check',
          depends_on: ['count'],
          bash: failOnce
            ? 'n=$(cat counter); if [ "$n" = 2 ] && [ ! -f failed ]; then touch failed; exit 1; fi; echo "checked-$n"'
            : 'echo "checked-$(cat counter)"',
        },
      ],
    },
  };
}

async function failThenResume(group: Record<string, unknown>, failOnce: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'loop-failure-resume-'));
  const store = await createFileWorkflowStore({ root: join(root, 'store') });
  const created = await store.createWorkflowRun({ workflow_name: 'rounds', user_message: '' });
  const run = await store.claimPendingWorkflowRun(created.id, root);
  if (!run) throw new Error('Claim failed');
  const options = dagOptions({
    deps: createMockDeps(store),
    cwd: root,
    workflowRun: run,
    workflow: { name: 'rounds', nodes: [dagNodeSchema.parse(roundsGroup(group, failOnce))] },
  });
  await executeDagWorkflow(options);
  expect((await store.getWorkflowRun(run.id))?.status).toBe('failed');
  const counterAfterFailure = (await readFile(join(root, 'counter'), 'utf8')).trim();
  const candidate = await store.getWorkflowRun(run.id);
  if (!candidate) throw new Error('Missing run');
  const resumed = await hydrateResumableRun({ store }, candidate);
  if (!resumed) throw new Error('Missing resume');
  await executeDagWorkflow({ ...options, ...resumed, workflowRun: resumed.preCreatedRun });
  const events = await store.listWorkflowEvents(run.id);
  const groupRecords = events
    .filter(e => e.step_name === 'rounds' && e.event_type !== 'loop_iteration_started')
    .map(e => readNodeRecordEvent(e))
    .filter(r => r !== undefined);
  return {
    root,
    status: (await store.getWorkflowRun(run.id))?.status,
    counterAfterFailure,
    counter: (await readFile(join(root, 'counter'), 'utf8')).trim(),
    iterations: events
      .filter(e => e.step_name === 'rounds' && e.event_type === 'loop_iteration_started')
      .map(e => e.data.iteration),
    countOutputs: events
      .filter(e => e.step_name === 'rounds.count' && e.event_type === 'node_completed')
      .map(e => readNodeRecordEvent(e)?.data.node_output?.trim()),
    lastGroupRecord: groupRecords.at(-1),
  };
}

test('a group that failed in round two resumes in round two and keeps its earlier rounds', async () => {
  const result = await failThenResume({ on_exhausted: 'complete' }, true);
  try {
    expect(result.counterAfterFailure).toBe('2');
    expect(result.status).toBe('completed');
    // Round one never runs again; round two re-runs in full, then round three.
    expect(result.iterations).toEqual([1, 2, 2, 3]);
    expect(result.counter).toBe('4');
    expect(result.countOutputs).toEqual([
      "run=1 prev=['']",
      "run=2 prev=['checked-1']",
      "run=3 prev=['checked-1']",
      "run=4 prev=['checked-3']",
    ]);
    // Rounds used before the failure count: the group exhausts at three and completes.
    expect(result.lastGroupRecord?.metadata?.lifecycle.status).toBe('completed');
    expect(result.lastGroupRecord?.data.maxIterations).toBe(3);
    expect(result.lastGroupRecord?.data.node_output).toBe('checked-4');
  } finally {
    await removeTempTree(result.root);
  }
});

test('a group that ran out of rounds fails again on resume without a new round', async () => {
  const result = await failThenResume({}, false);
  try {
    expect(result.counterAfterFailure).toBe('3');
    expect(result.status).toBe('failed');
    expect(result.counter).toBe('3');
    expect(result.iterations).toEqual([1, 2, 3]);
    const lifecycle = result.lastGroupRecord?.metadata?.lifecycle;
    expect(lifecycle?.status === 'failed' ? lifecycle.failureKind : undefined).toBe(
      'max_iterations'
    );
  } finally {
    await removeTempTree(result.root);
  }
});
