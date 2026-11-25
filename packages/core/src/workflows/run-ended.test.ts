import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { RunEndedFacts } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { providerRegistry } from '@archon/providers';
import type { EndedCheckout } from '@archon/workflows/schemas/resource-start';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import {
  createRunEndedPreflight,
  createRunEndedStarts,
  launchProjectKey,
  readTriggerFileHosts,
} from './run-ended';
import { runEndedStops } from './run-ended-stops';

/** No project is registered in these tests. */
const NO_PROJECT_LOOKUPS = {
  projectOf: async () => null,
};

const track = trackTempRoots();

const ITEM = { id: 'item-row', projectKey: 'acme/widgets', key: 'issue-7' };
const PROJECT_CWD = '/srv/widgets';

function endedRun(fields: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: null,
    id: '9b2f6f0e-31a4-4d0c-8f0a-3f6c2f1b7a01',
    workflow_name: 'plan',
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    completed_outcome: null,
    user_message: '',
    metadata: {},
    active_phase_started_at: null,
    started_at: new Date('2026-11-16T09:00:00.000Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: ITEM.id,
    ...fields,
  };
}

function facts(fields: Partial<RunEndedFacts> = {}): RunEndedFacts {
  return {
    run: endedRun(),
    declaredInputs: ['issue'],
    outcomeForm: { kind: 'enum', values: ['planned', 'blocked'] },
    outcome: { kind: 'enum', value: 'planned' },
    result: { outcome: 'planned', plan: { steps: ['a', 'b'] } },
    inputs: { issue: 'Fix the login page' },
    ...fields,
  };
}

function trigger(fields: { cwd?: string; on?: unknown; sourceInstanceId?: string } = {}) {
  return {
    version: 1,
    sourceInstanceId: fields.sourceInstanceId ?? 'build-after-plan',
    binding: {
      bindingId: 'build',
      bindingRevision: null,
      hostId: 'factory-host',
      runAsUserId: 'operator',
      resource: 'build',
      overlap: 'queue',
      launch: {
        cwd: fields.cwd ?? PROJECT_CWD,
        workflowName: 'build',
        inputs: {},
        isolation: { kind: 'default' },
      },
    },
    on: fields.on ?? {
      runEnded: {
        workflowName: 'plan',
        outcome: 'planned',
        inputs: { plan: { result: '/plan' }, issue: { input: 'issue' } },
      },
    },
  };
}

// A binding without `checkout` never reads the ended run's checkout.
const noCheckout = (): Promise<EndedCheckout> =>
  Promise.reject(new Error('no binding here reads the checkout'));
// A binding without `{item: 'answers'}` never reads the item's asks.
const noItemAnswers = (): Promise<never> =>
  Promise.reject(new Error("no binding here reads the item's answers"));

async function triggersWith(
  files: Record<string, unknown>,
  endedCheckout: (run: WorkflowRun) => Promise<EndedCheckout> = noCheckout,
  listItemAsks: (itemId: string) => Promise<AttentionRead<StoredItemAsk>[]> = noItemAnswers
) {
  const directory = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-')));
  for (const [name, value] of Object.entries(files))
    await writeFile(
      join(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value)
    );
  return createRunEndedStarts({
    triggersDirectory: () => directory,
    getItem: async id => (id === ITEM.id ? ITEM : null),
    projectKeyOf: async cwd => (cwd === PROJECT_CWD ? ITEM.projectKey : 'acme/other'),
    endedCheckout,
    listItemAsks,
    now: () => new Date('2026-11-16T10:00:00.000Z'),
  });
}

describe('run-ended starts', () => {
  test('a matching binding becomes one receipt on the item, caused by the ended run', async () => {
    const starts = await triggersWith({
      'build.json': trigger(),
      // A schedule or fire-only file is not a run-ended binding and is not read further.
      'refresh.json': { ...trigger({ sourceInstanceId: 'refresh' }), on: undefined },
    });
    const [receipt, ...rest] = (await starts(facts())).receipts;
    expect(rest).toEqual([]);
    expect(receipt).toMatchObject({
      outcome: 'matched',
      receipt: {
        sourceInstanceId: 'build-after-plan',
        deliveryId: endedRun().id,
        itemKey: ITEM.key,
        sourceActor: { source: 'archon-run-ended', id: endedRun().id, display: 'planned' },
      },
      bindings: [
        {
          bindingId: 'build',
          hostId: 'factory-host',
          eventInputs: { plan: { steps: ['a', 'b'] }, issue: 'Fix the login page' },
        },
      ],
    });
    expect(receipt?.bindings[0]?.bindingRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the stage started is the one the binding names, whatever the ended run returned', async () => {
    const starts = await triggersWith({ 'build.json': trigger() });
    const [receipt] = (
      await starts(
        facts({ result: { outcome: 'planned', plan: 'p', next: 'deploy', workflow: 'deploy' } })
      )
    ).receipts;
    expect(receipt?.bindings.map(binding => binding.launch.workflowName)).toEqual(['build']);
  });

  test.each([
    ['a run with no item', facts({ run: endedRun({ item_id: null }) })],
    ['another workflow', facts({ run: endedRun({ workflow_name: 'review' }) })],
    ['another outcome', facts({ outcome: { kind: 'enum', value: 'blocked' } })],
  ])('%s starts nothing', async (_label, ended) => {
    const starts = await triggersWith({ 'build.json': trigger() });
    expect(await starts(ended)).toEqual({ receipts: [], linked: [] });
  });

  test('a run with no item reads no trigger file, so a malformed one cannot fail it', async () => {
    const directory = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-')));
    await writeFile(join(directory, 'broken.json'), '{ not json');
    const dependencies = {
      triggersDirectory: () => directory,
      getItem: async () => ITEM,
      projectKeyOf: async () => ITEM.projectKey,
      endedCheckout: noCheckout,
      listItemAsks: noItemAnswers,
    };
    const noItem = endedRun({ item_id: null });
    expect(await createRunEndedStarts(dependencies)(facts({ run: noItem }))).toEqual({
      receipts: [],
      linked: [],
    });
    const preflight = createRunEndedPreflight({
      ...dependencies,
      providers: providerRegistry,
      loadConfig: () => Promise.reject(new Error('a run with no item loads no config')),
      ...NO_PROJECT_LOOKUPS,
    });
    expect(await preflight(noItem)).toBeUndefined();
  });

  test('a binding that launches in another project starts nothing, even with a bad mapping', async () => {
    const starts = await triggersWith({
      'build.json': trigger({
        cwd: '/srv/other',
        on: { runEnded: { workflowName: 'plan', outcome: 'typo' } },
      }),
    });
    expect(await starts(facts())).toEqual({ receipts: [], linked: [] });
  });

  test('no triggers directory starts nothing', async () => {
    const starts = createRunEndedStarts({
      triggersDirectory: () => join(tmpdir(), `archon-no-triggers-${crypto.randomUUID()}`),
      getItem: async () => ITEM,
      projectKeyOf: async () => ITEM.projectKey,
      endedCheckout: noCheckout,
      listItemAsks: noItemAnswers,
    });
    expect(await starts(facts())).toEqual({ receipts: [], linked: [] });
  });

  test('a linked binding becomes a linked start for the write to resolve, and no receipt', async () => {
    const starts = await triggersWith({
      'each.json': trigger({
        sourceInstanceId: 'review-each',
        on: {
          runEnded: {
            workflowName: 'plan',
            outcome: 'planned',
            linked: { kind: 'part_of', holder: 'to' },
            inputs: { member: { item: 'key' }, plan: { result: '/plan' } },
          },
        },
      }),
    });
    const { receipts, linked } = await starts(facts());
    expect(receipts).toEqual([]);
    expect(linked).toMatchObject([
      {
        link: { kind: 'part_of', holder: 'to' },
        endedRunId: endedRun().id,
        endedItemId: ITEM.id,
        // Which member ended, and what it ended with.
        acceptance: {
          outcome: 'matched',
          receipt: {
            sourceInstanceId: 'review-each',
            sourceActor: { source: 'archon-run-ended', id: endedRun().id },
          },
          bindings: [{ eventInputs: { member: ITEM.key, plan: { steps: ['a', 'b'] } } }],
        },
      },
    ]);
    // Another outcome causes nothing.
    expect(await starts(facts({ outcome: { kind: 'enum', value: 'blocked' } }))).toEqual({
      receipts: [],
      linked: [],
    });
  });

  describe('a linked binding that names its items', () => {
    const split = (inputs: Record<string, unknown> = { brief: { entry: '/brief' } }) =>
      triggersWith({
        'split.json': trigger({
          sourceInstanceId: 'order-after-split',
          on: {
            runEnded: {
              workflowName: 'plan',
              outcome: 'planned',
              linked: { kind: 'part_of', holder: 'from', items: '/start' },
              inputs,
            },
          },
        }),
      });
    const withStart = (start: unknown) =>
      facts({ result: { outcome: 'planned', start } as RunEndedFacts['result'] });

    test('names each item to start, with the inputs its own entry maps', async () => {
      const starts = await split({ brief: { entry: '/brief' }, part_of: { item: 'key' } });
      const { receipts, linked } = await starts(
        withStart([
          { key: 'm1', brief: 'first' },
          { key: 'm2', brief: 'second' },
        ])
      );
      expect(receipts).toEqual([]);
      const [start] = linked;
      if (!start || !('named' in start)) throw new Error('no named linked start');
      expect(
        start.named.map(named => [
          named.key,
          named.acceptance.receipt.itemKey,
          named.acceptance.outcome === 'matched' ? named.acceptance.bindings[0]?.eventInputs : null,
        ])
      ).toEqual([
        ['m1', 'm1', { brief: 'first', part_of: ITEM.key }],
        ['m2', 'm2', { brief: 'second', part_of: ITEM.key }],
      ]);
      const [first, second] = start.named;
      expect(first?.acceptance.receipt.contentDigest).not.toBe(
        second?.acceptance.receipt.contentDigest
      );
      // What the write records on the ended run's item when 'm1' holds no such link.
      expect(first?.unlinked).toMatchObject({
        outcome: 'unmatched',
        receipt: { itemKey: ITEM.key, deliveryId: `${endedRun().id}:unlinked:m1` },
      });
      expect(first?.unlinked.reason).toContain(
        `item 'm1' is named at linked.items '/start' but holds no active part_of link (holder: from) to '${ITEM.key}'`
      );
    });

    test('an entry may be the key itself, read whole by an empty pointer', async () => {
      const starts = await split({ member: { entry: '' } });
      const [start] = (await starts(withStart(['m1']))).linked;
      if (!start || !('named' in start)) throw new Error('no named linked start');
      expect(start.named[0]?.acceptance).toMatchObject({
        receipt: { itemKey: 'm1' },
        bindings: [{ eventInputs: { member: 'm1' } }],
      });
    });

    test('an entry its input pointer misses refuses only its own start', async () => {
      const starts = await split();
      const [start] = (await starts(withStart([{ key: 'm1', brief: 'b' }, { key: 'm2' }]))).linked;
      if (!start || !('named' in start)) throw new Error('no named linked start');
      expect(start.named.map(named => named.acceptance.outcome)).toEqual(['matched', 'unmatched']);
      expect(start.named[1]?.acceptance.reason).toContain("entry pointer '/brief' did not resolve");
    });

    test('an empty list starts nothing and records nothing', async () => {
      expect(await (await split())(withStart([]))).toEqual({ receipts: [], linked: [] });
    });

    test.each([
      ['a missing list', undefined, 'did not resolve'],
      ['a value that is not a list', { key: 'm1' }, 'is not a list'],
      ['an entry with no key', [{ brief: 'b' }], 'entry 0 names no item key'],
      ['an empty key', ['m1', ''], 'entry 1 names no item key'],
      ['a key named twice', ['m1', { key: 'm1' }], "names item 'm1' more than once"],
    ])('%s refuses the binding on the ended item and starts none', async (_label, start, why) => {
      const starts = await split();
      const ended = start === undefined ? facts() : withStart(start);
      const { receipts, linked } = await starts(ended);
      expect(linked).toEqual([]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        outcome: 'unmatched',
        receipt: { itemKey: ITEM.key, deliveryId: endedRun().id },
      });
      expect(receipts[0]?.reason).toContain(`split.json: linked.items '/start' ${why}`);
    });
  });

  test('a linked binding naming an unknown link kind or taking a checkout is refused', async () => {
    for (const runEnded of [
      { linked: { kind: 'blocks', holder: 'to' } },
      { linked: { kind: 'part_of', holder: 'to' }, checkout: 'ended-run' },
    ]) {
      const starts = await triggersWith({
        'linked.json': trigger({
          on: { runEnded: { workflowName: 'plan', outcome: 'planned', ...runEnded } },
        }),
      });
      await expect(starts(facts())).rejects.toThrow('linked.json is invalid');
    }
  });

  test('a result pointer that names nothing is recorded as a rejected binding', async () => {
    const starts = await triggersWith({
      'build.json': trigger({
        on: {
          runEnded: {
            workflowName: 'plan',
            outcome: 'planned',
            inputs: { plan: { result: '/missing' } },
          },
        },
      }),
    });
    const [receipt, ...rest] = (await starts(facts())).receipts;
    expect(rest).toEqual([]);
    expect(receipt).toMatchObject({
      outcome: 'unmatched',
      bindings: [],
      evaluatedBindings: [{ bindingId: 'build', status: 'rejected' }],
    });
    // The receipt itself carries why, so `trigger list` shows it: the file and the pointer.
    expect(receipt?.reason).toContain('build.json');
    expect(receipt?.reason).toContain('/missing');
    expect(receipt?.evaluatedBindings?.[0]?.reason).toContain('/missing');
  });

  test.each([
    [
      'reads an input the ended workflow does not declare',
      {
        runEnded: { workflowName: 'plan', outcome: 'planned', inputs: { x: { input: 'secret' } } },
      },
      'secret',
    ],
    [
      'names an outcome the ended workflow cannot complete with',
      { runEnded: { workflowName: 'plan', outcome: 'plannned' } },
      'plannned',
    ],
  ])('a binding that %s is refused naming its file', async (_label, on, offending) => {
    const starts = await triggersWith({ 'build.json': trigger({ on }) });
    const refused = starts(facts());
    await expect(refused).rejects.toThrow(offending);
    await expect(refused).rejects.toThrow('build.json');
  });

  test.each([
    ['a file that is not JSON', { 'broken.json': '{ not json' }, ['broken.json']],
    [
      'an invalid on.runEnded',
      { 'build.json': trigger({ on: { runEnded: { workflowName: 'plan' } } }) },
      ['build.json', 'on.runEnded.outcome'],
    ],
    [
      'two files with one source',
      { 'a.json': trigger(), 'b.json': trigger() },
      ['a.json', 'b.json', 'build-after-plan'],
    ],
  ])('%s fails the read loudly', async (_label, files, named) => {
    const starts = await triggersWith(files);
    const refused = starts(facts());
    for (const name of named) await expect(refused).rejects.toThrow(name);
  });

  test('a binding whose project cannot be resolved fails naming its file', async () => {
    const directory = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-')));
    await writeFile(join(directory, 'build.json'), JSON.stringify(trigger()));
    const dependencies = {
      triggersDirectory: () => directory,
      getItem: async () => ITEM,
      projectKeyOf: () => Promise.reject(new Error('Failed to find repo root for /srv/widgets')),
      endedCheckout: noCheckout,
      listItemAsks: noItemAnswers,
    };
    for (const read of [
      () => createRunEndedStarts(dependencies)(facts()),
      () =>
        createRunEndedPreflight({
          ...dependencies,
          providers: providerRegistry,
          loadConfig: () => Promise.reject(new Error('not reached')),
          ...NO_PROJECT_LOOKUPS,
        })(endedRun()),
    ]) {
      const refused = read();
      await expect(refused).rejects.toThrow('build.json');
      await expect(refused).rejects.toThrow('Failed to find repo root');
    }
  });

  test('a binding that takes the ended checkout starts on its branch and records the commit', async () => {
    const handoff = { runId: endedRun().id, branch: 'archon/task-plan-1', commit: 'c'.repeat(40) };
    const reads: string[] = [];
    const checkoutTrigger = (sourceInstanceId: string) =>
      trigger({
        sourceInstanceId,
        on: { runEnded: { workflowName: 'plan', outcome: 'planned', checkout: 'ended-run' } },
      });
    const starts = await triggersWith(
      { 'build.json': checkoutTrigger('build'), 'check.json': checkoutTrigger('check') },
      async run => {
        reads.push(run.id);
        return { handoff };
      }
    );
    const { receipts } = await starts(facts());
    // Read once per completion, however many bindings take it.
    expect(reads).toEqual([endedRun().id]);
    for (const receipt of receipts)
      expect(receipt).toMatchObject({
        outcome: 'matched',
        bindings: [
          {
            checkoutFrom: handoff,
            launch: { isolation: { kind: 'worktree', branch: 'archon/task-plan-1' } },
          },
        ],
      });
  });

  test('a binding whose ended run left no checkout is rejected on its receipt, naming why', async () => {
    const refused = 'the checkout of the ended run is gone';
    const starts = await triggersWith(
      {
        'build.json': trigger({
          on: { runEnded: { workflowName: 'plan', outcome: 'planned', checkout: 'ended-run' } },
        }),
      },
      async () => ({ refused })
    );
    const [receipt] = (await starts(facts())).receipts;
    expect(receipt).toMatchObject({
      outcome: 'unmatched',
      bindings: [],
      evaluatedBindings: [{ bindingId: 'build', status: 'rejected' }],
    });
    expect(receipt?.reason).toContain('build.json');
    expect(receipt?.reason).toContain(refused);
  });

  test('a fixed isolation beside checkout: ended-run is refused when the file is read', async () => {
    const file = trigger({
      on: { runEnded: { workflowName: 'plan', outcome: 'planned', checkout: 'ended-run' } },
    });
    file.binding.launch.isolation = { kind: 'in-place' };
    const starts = await triggersWith({ 'build.json': file });
    await expect(starts(facts())).rejects.toThrow('binding.launch.isolation');
  });

  test("a binding reading the item's answers gets every settled set on the item, oldest answer first", async () => {
    const act = (at: string) => ({ at, via: 'cli' as const, by: null, fromRun: null });
    const stored = (
      runId: string,
      workflowName: string,
      position: number,
      closed: StoredItemAsk['closed']
    ): StoredItemAsk => ({
      id: `${runId}-${String(position)}`,
      itemId: ITEM.id,
      runId,
      workflowName,
      position,
      ask: {
        question: `${workflowName} ${String(position)}?`,
        context: 'Two readings.',
        options: [{ id: 'keep', does: 'Keep it.', cost: 'More to maintain.' }],
        recommendation: { option: 'keep', why: 'Nothing needs it gone.' },
        artifacts: [],
      },
      openedAt: '2026-11-16T09:00:00.000Z',
      closed,
    });
    const keep = { decision: 'keep', text: '' };
    // The rows come in the order the asks were left; plan's first ask was answered last.
    const rows: StoredItemAsk[] = [
      stored('plan-run', 'plan', 0, {
        as: 'answered',
        answer: keep,
        act: act('2026-11-16T09:40:00.000Z'),
      }),
      stored('plan-run', 'plan', 1, { as: 'withdrawn', act: act('2026-11-16T09:11:00.000Z') }),
      stored('old-check', 'check', 0, {
        as: 'replaced',
        at: '2026-11-16T09:20:00.000Z',
        byRunId: 'check-run',
      }),
      stored('check-run', 'check', 0, {
        as: 'answered',
        answer: keep,
        act: act('2026-11-16T09:30:00.000Z'),
      }),
      stored('review-run', 'review', 0, null),
    ];
    const reads: string[] = [];
    const answersTrigger = (sourceInstanceId: string) =>
      trigger({
        sourceInstanceId,
        on: {
          runEnded: {
            workflowName: 'plan',
            outcome: 'planned',
            inputs: { decisions: { item: 'answers' }, issue: { item: 'key' } },
          },
        },
      });
    const starts = await triggersWith(
      { 'build.json': answersTrigger('build'), 'check.json': answersTrigger('check') },
      noCheckout,
      async itemId => {
        reads.push(itemId);
        return rows;
      }
    );
    const { receipts } = await starts(facts());
    // Read once per completion, however many bindings read them.
    expect(reads).toEqual([ITEM.id]);
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts)
      expect(receipt.bindings[0]?.eventInputs).toEqual({
        issue: ITEM.key,
        decisions: [
          {
            question: 'plan 1?',
            closedAs: 'withdrawn',
            answer: null,
            option: null,
            by: null,
            via: 'cli',
            at: '2026-11-16T09:11:00.000Z',
            workflowName: 'plan',
          },
          {
            question: 'check 0?',
            closedAs: 'answered',
            answer: keep,
            option: { id: 'keep', does: 'Keep it.' },
            by: null,
            via: 'cli',
            at: '2026-11-16T09:30:00.000Z',
            workflowName: 'check',
          },
          {
            question: 'plan 0?',
            closedAs: 'answered',
            answer: keep,
            option: { id: 'keep', does: 'Keep it.' },
            by: null,
            via: 'cli',
            at: '2026-11-16T09:40:00.000Z',
            workflowName: 'plan',
          },
        ],
      });
  });

  test("an unreadable ask on the item rejects only the binding that reads the item's answers", async () => {
    const starts = await triggersWith(
      {
        'build.json': trigger({
          on: {
            runEnded: {
              workflowName: 'plan',
              outcome: 'planned',
              inputs: { decisions: { item: 'answers' } },
            },
          },
        }),
        'check.json': trigger({ sourceInstanceId: 'check' }),
      },
      noCheckout,
      async () => [{ type: 'degraded', reason: 'run_unreadable', runId: 'old-run' }]
    );
    const receipts = (await starts(facts())).receipts;
    const build = receipts.find(receipt => receipt.receipt.sourceInstanceId === 'build-after-plan');
    expect(build).toMatchObject({ outcome: 'unmatched', bindings: [] });
    expect(build?.reason).toContain("run 'old-run'");
    expect(receipts.find(receipt => receipt.receipt.sourceInstanceId === 'check')).toMatchObject({
      outcome: 'matched',
    });
  });

  // A stale file for another project must not fail item runs of its workflow here.
  test('a launch from a checkout that no longer exists is in no project', async () => {
    const present = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-cwd-')));
    const projectKeyOf = launchProjectKey(async () => ITEM.projectKey);
    expect(await projectKeyOf(present)).toBe(ITEM.projectKey);
    expect(await projectKeyOf(join(present, 'deleted'))).toBeNull();
  });
});

describe('the hosts trigger files name', () => {
  const file = (sourceInstanceId: string, hostId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      sourceInstanceId,
      binding: {
        bindingId: sourceInstanceId,
        bindingRevision: null,
        hostId,
        runAsUserId: 'user',
        resource: 'build',
        overlap: 'queue',
        launch: {
          cwd: '/project',
          workflowName: 'build',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
      ...extra,
    });

  test('are every distinct host, of any form, and a broken file is reported by name beside them', async () => {
    const directory = track(await mkdtemp(join(tmpdir(), 'archon-trigger-hosts-')));
    await writeFile(join(directory, 'a-fire.json'), file('fire', 'mac'));
    await writeFile(
      join(directory, 'b-timer.json'),
      file('timer', 'linux', { schedule: { intervalSeconds: 60, runAtLoad: false } })
    );
    await writeFile(
      join(directory, 'c-on.json'),
      file('on', 'mac', {
        on: { runEnded: { workflowName: 'plan', outcome: 'planned', inputs: {} } },
      })
    );
    await writeFile(join(directory, 'd-broken.json'), '{ not json');
    await writeFile(join(directory, 'e-staged.json.tmp'), file('staged', 'staged-host'));
    const { hostIds, failures } = await readTriggerFileHosts(directory);
    expect(hostIds).toEqual(['mac', 'linux']);
    expect(failures.map(failure => failure.message)).toEqual([
      expect.stringContaining('d-broken.json'),
    ]);
  });

  test('are none when the directory does not exist', async () => {
    const directory = track(await mkdtemp(join(tmpdir(), 'archon-trigger-hosts-')));
    expect(await readTriggerFileHosts(join(directory, 'missing'))).toEqual({
      hostIds: [],
      failures: [],
    });
  });
});

describe('the outcomes after which an item stops', () => {
  test('are those of a named step workflow that neither end the item nor start a step on it', async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-stops-')));
    const workflows = join(root, '.archon', 'workflows');
    await mkdir(workflows, { recursive: true });
    const stage = (name: string, returns: string, observes = false): string =>
      `name: ${name}\ndescription: ${name}\n${observes ? 'observes: true\n' : ''}returns: ${returns}\nnodes:\n  - id: result\n    bash: echo '{}'\n    output_format:\n      type: object\n      properties:\n        stage: { type: string, enum: [approve, replan, landed, advise] }\n      required: [stage]\n`;
    await writeFile(
      join(workflows, 'deliver.yaml'),
      stage('deliver', '{ node: result, outcome: stage, ends: [landed] }')
    );
    await writeFile(
      join(workflows, 'shadow.yaml'),
      stage('shadow', '{ node: result, outcome: stage }', true)
    );
    await writeFile(
      join(workflows, 'review.yaml'),
      stage('review', '{ node: result, outcome: stage, asks: asks }')
    );
    const binding = {
      bindingId: 'b',
      bindingRevision: null,
      hostId: 'host',
      runAsUserId: 'operator',
      resource: 'r',
      overlap: 'queue' as const,
      launch: {
        cwd: root,
        workflowName: 'review',
        inputs: {},
        isolation: { kind: 'default' as const },
      },
    };

    const stops = await runEndedStops(
      [
        {
          file: 'b.json',
          sourceInstanceId: 'b',
          binding,
          runEnded: { workflowName: 'deliver', outcome: 'approve' },
        },
        {
          file: 'l.json',
          sourceInstanceId: 'l',
          binding: { ...binding, bindingId: 'l' },
          runEnded: {
            workflowName: 'deliver',
            outcome: 'replan',
            linked: { kind: 'part_of' as const, holder: 'to' as const },
          },
        },
        {
          file: 'm.json',
          sourceInstanceId: 'm',
          binding: {
            ...binding,
            bindingId: 'm',
            launch: { ...binding.launch, workflowName: 'gone' },
          },
          runEnded: { workflowName: 'review', outcome: 'approve' },
        },
        {
          file: 's.json',
          sourceInstanceId: 's',
          binding: {
            ...binding,
            bindingId: 's',
            launch: { ...binding.launch, workflowName: 'shadow' },
          },
          runEnded: { workflowName: 'deliver', outcome: 'advise' },
        },
      ],
      {
        loadConfig: async () => ({
          assistant: 'claude' as const,
          assistants: { claude: {}, codex: {} },
          commands: {},
        }),
        providers: providerRegistry,
        projectOf: async () => null,
        projectKeyOf: async () => 'acme/widgets',
      }
    );

    // `deliver:approve` is bound to a step and `landed` ends the item; `replan` is bound only
    // to a start on linked items, and `advise` only to `shadow`, which observes its item and
    // starts no step. `review:approve` is bound by a file that starts a missing workflow, so
    // its runs start nothing, and `review` stops its item only when a run leaves no ask.
    // `shadow` observes its item, so none of its outcomes stops it.
    const project = 'acme/widgets';
    expect(stops).toEqual([
      { project, workflow: 'deliver', outcome: 'replan', unless: [] },
      { project, workflow: 'deliver', outcome: 'advise', unless: [] },
      ...['approve', 'replan', 'landed', 'advise'].map(outcome => ({
        project,
        workflow: 'review',
        outcome,
        unless: ['asks' as const],
      })),
    ]);
  });
});

test('each binding of a project reads the workflows of its own definition source', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-sources-')));
  const deps = {
    loadConfig: async () => ({
      assistant: 'claude' as const,
      assistants: { claude: {}, codex: {} },
      commands: {},
    }),
    providers: providerRegistry,
    projectOf: async () => null,
    projectKeyOf: async () => 'acme/widgets',
  };
  const fireOnly = async (name: string) => {
    const source = join(root, `${name}-source`);
    await mkdir(join(source, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(source, '.archon', 'workflows', `${name}.yaml`),
      `name: ${name}\ndescription: ${name}\nreturns: { node: result, outcome: stage }\nnodes:\n  - id: result\n    bash: echo '{}'\n    output_format:\n      type: object\n      properties:\n        stage: { type: string, enum: [replan] }\n      required: [stage]\n`
    );
    return {
      file: `${name}.json`,
      sourceInstanceId: name,
      binding: {
        bindingId: name,
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: 'operator',
        resource: 'r',
        overlap: 'queue' as const,
        launch: {
          cwd: root,
          discoveryCwd: source,
          workflowName: name,
          inputs: {},
          isolation: { kind: 'default' as const },
        },
      },
    };
  };

  const stops = await runEndedStops([await fireOnly('alpha'), await fireOnly('beta')], deps);

  expect(stops.map(stop => stop.workflow).sort()).toEqual(['alpha', 'beta']);
});
