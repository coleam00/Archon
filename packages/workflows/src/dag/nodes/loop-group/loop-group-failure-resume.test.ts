// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { hydrateResumableRun } from '../../../run-resume';
import { readNodeRecordEvent } from '../../../node-record-reader';
import { dagNodeSchema } from '../../../schemas';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  deliveredMessages,
} from '../../test-utils';

type FileStore = Awaited<ReturnType<typeof createFileWorkflowStore>>;

// `count` numbers every body run in a counter file; `check` fails once, when the counter
// reads 2, if `failOnce` is set. Resume must continue in the round it stopped in.
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

interface Scenario {
  group: Record<string, unknown>;
  failOnce: boolean;
  /** Wraps the first run's store, to stop it at a chosen record. */
  interrupt?: (store: FileStore) => void;
  /** Edits the first run's records before the resume reads them. */
  afterFirstRun?: (store: FileStore, storeRoot: string, runId: string) => Promise<void>;
}

async function stopThenResume(root: string, scenario: Scenario) {
  const storeRoot = join(root, 'store');
  const store = await createFileWorkflowStore({ root: storeRoot });
  const created = await store.createWorkflowRun({ workflow_name: 'rounds', user_message: '' });
  const run = await store.claimPendingWorkflowRun(created.id, root);
  if (!run) throw new Error('Claim failed');
  const workflow = {
    name: 'rounds',
    nodes: [dagNodeSchema.parse(roundsGroup(scenario.group, scenario.failOnce))],
  };
  scenario.interrupt?.(store);
  await executeDagWorkflow(
    dagOptions({ deps: createMockDeps(store), cwd: root, workflowRun: run, workflow })
  ).catch(() => undefined);
  const counterAfterFirstRun = (await readFile(join(root, 'counter'), 'utf8')).trim();
  await scenario.afterFirstRun?.(store, storeRoot, run.id);
  const resumeStore = await createFileWorkflowStore({ root: storeRoot });
  const candidate = await resumeStore.getWorkflowRun(run.id);
  if (!candidate) throw new Error('Missing run');
  const resumed = await hydrateResumableRun({ store: resumeStore }, candidate);
  if (!resumed) throw new Error('Missing resume');
  const platform = createMockPlatform();
  await executeDagWorkflow({
    ...dagOptions({ deps: createMockDeps(resumeStore), cwd: root, workflowRun: run, workflow }),
    platform,
    ...resumed,
    workflowRun: resumed.preCreatedRun,
  });
  const events = await resumeStore.listWorkflowEvents(run.id);
  const groupRecords = events
    .filter(e => e.step_name === 'rounds' && e.event_type !== 'loop_iteration_started')
    .map(e => readNodeRecordEvent(e))
    .filter(r => r !== undefined);
  return {
    status: (await resumeStore.getWorkflowRun(run.id))?.status,
    counterAfterFirstRun,
    counter: (await readFile(join(root, 'counter'), 'utf8')).trim(),
    iterations: events
      .filter(e => e.step_name === 'rounds' && e.event_type === 'loop_iteration_started')
      .map(e => e.data.iteration),
    countOutputs: events
      .filter(e => e.step_name === 'rounds.count' && e.event_type === 'node_completed')
      .map(e => readNodeRecordEvent(e)?.data.node_output?.trim()),
    lastGroupRecord: groupRecords.at(-1),
    messages: deliveredMessages(platform),
  };
}

async function inTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'loop-failure-resume-'));
  try {
    return await fn(root);
  } finally {
    await removeTempTree(root);
  }
}

// Completes in the third round: the fourth body run, counting round two's re-run.
const completesInRoundThree = { until_bash: 'test "$(cat counter)" = 4' };

/** Drops the group's node_failed record, leaving it started, as a killed process would. */
async function dropGroupFailure(
  _store: FileStore,
  storeRoot: string,
  runId: string
): Promise<void> {
  const log = join(storeRoot, 'runs', runId, 'log.jsonl');
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  let dropped = 0;
  const kept = lines.map(line => {
    const entry = JSON.parse(line) as { events: { step_name?: string; event_type: string }[] };
    const events = entry.events.filter(
      e => !(e.step_name === 'rounds' && e.event_type === 'node_failed')
    );
    dropped += entry.events.length - events.length;
    return JSON.stringify({ ...entry, events });
  });
  expect(dropped).toBe(1);
  await writeFile(log, `${kept.join('\n')}\n`);
}

for (const [name, afterFirstRun] of [
  ['failed', undefined],
  ['killed', dropGroupFailure],
] as const) {
  test(`a group ${name} in round two resumes in round two and keeps its earlier rounds`, () =>
    inTempRoot(async root => {
      const result = await stopThenResume(root, {
        group: completesInRoundThree,
        failOnce: true,
        afterFirstRun,
      });
      expect(result.counterAfterFirstRun).toBe('2');
      expect(result.status).toBe('completed');
      // Round one never runs again; round two re-runs in full, then round three.
      expect(result.iterations).toEqual([1, 2, 2, 3]);
      expect(result.countOutputs).toEqual([
        "run=1 prev=['']",
        "run=2 prev=['checked-1']",
        "run=3 prev=['checked-1']",
        "run=4 prev=['checked-3']",
      ]);
      expect(result.messages).toContain("Loop-group node 'rounds' completed after 3 iterations");
      expect(result.lastGroupRecord?.metadata?.lifecycle.status).toBe('completed');
      expect(result.lastGroupRecord?.data.node_output).toBe('checked-4');
    }));
}

/**
 * Stops the first run at the first record `matches` selects: that record never reaches the
 * store, so the run is left running with no live owner, and an operator fails it to resume.
 */
function stopAtRecord(
  matches: (event: Parameters<FileStore['persistWorkflowEvent']>[0]) => boolean
): Pick<Scenario, 'interrupt' | 'afterFirstRun'> {
  return {
    interrupt: store => {
      const persist = store.persistWorkflowEvent.bind(store);
      let rejected = false;
      store.persistWorkflowEvent = async event => {
        if (!rejected && matches(event)) {
          rejected = true;
          throw new Error('store unavailable');
        }
        return persist(event);
      };
    },
    afterFirstRun: async (store, _root, runId) => {
      expect((await store.getWorkflowRun(runId))?.status).toBe('running');
      await store.failWorkflowRun(runId, 'owner gone');
    },
  };
}

test('a group stopped between rounds resumes in the next round without replaying the last', () =>
  inTempRoot(async root => {
    const result = await stopThenResume(root, {
      group: { until_bash: 'test "$(cat counter)" = 3' },
      failOnce: false,
      // Round one finished; round two's first body record never reaches the store.
      ...stopAtRecord(
        event =>
          event.step_name === 'rounds.count' &&
          event.event_type === 'node_started' &&
          event.data?.iteration === 2
      ),
    });
    expect(result.counterAfterFirstRun).toBe('1');
    expect(result.status).toBe('completed');
    expect(result.iterations).toEqual([1, 2, 2, 3]);
    expect(result.countOutputs).toEqual([
      "run=1 prev=['']",
      "run=2 prev=['checked-1']",
      "run=3 prev=['checked-2']",
    ]);
    expect(result.messages).toContain("Loop-group node 'rounds' completed after 3 iterations");
  }));

test('a group stopped after its last round finished completes on resume without re-running it', () =>
  inTempRoot(async root => {
    const result = await stopThenResume(root, {
      group: { until_bash: 'test "$(cat counter)" = 2' },
      failOnce: false,
      // Round two met the condition; the group's own completion never reaches the store.
      ...stopAtRecord(
        event => event.step_name === 'rounds' && event.event_type === 'node_completed'
      ),
    });
    expect(result.counterAfterFirstRun).toBe('2');
    expect(result.status).toBe('completed');
    expect(result.counter).toBe('2');
    expect(result.iterations).toEqual([1, 2]);
    expect(result.messages).toContain("Loop-group node 'rounds' completed after 2 iterations");
    expect(result.lastGroupRecord?.data.node_output).toBe('checked-2');
  }));

test('a group that ran out of rounds fails again on resume without a new round', () =>
  inTempRoot(async root => {
    const result = await stopThenResume(root, { group: {}, failOnce: false });
    expect(result.counterAfterFirstRun).toBe('3');
    expect(result.status).toBe('failed');
    expect(result.counter).toBe('3');
    expect(result.iterations).toEqual([1, 2, 3]);
    const lifecycle = result.lastGroupRecord?.metadata?.lifecycle;
    expect(lifecycle?.status === 'failed' ? lifecycle.failureKind : undefined).toBe(
      'max_iterations'
    );
  }));
