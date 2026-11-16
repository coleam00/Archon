import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { RunEndedFacts } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { providerRegistry } from '@archon/providers';
import type { EndedCheckout } from './ended-checkout';
import { createRunEndedPreflight, createRunEndedStarts, launchProjectKey } from './run-ended';

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

async function triggersWith(
  files: Record<string, unknown>,
  endedCheckout: (run: WorkflowRun) => Promise<EndedCheckout> = noCheckout
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
    const [receipt, ...rest] = await starts(facts());
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
    const [receipt] = await starts(
      facts({ result: { outcome: 'planned', plan: 'p', next: 'deploy', workflow: 'deploy' } })
    );
    expect(receipt?.bindings.map(binding => binding.launch.workflowName)).toEqual(['build']);
  });

  test.each([
    ['a run with no item', facts({ run: endedRun({ item_id: null }) })],
    ['another workflow', facts({ run: endedRun({ workflow_name: 'review' }) })],
    ['another outcome', facts({ outcome: { kind: 'enum', value: 'blocked' } })],
  ])('%s starts nothing', async (_label, ended) => {
    const starts = await triggersWith({ 'build.json': trigger() });
    expect(await starts(ended)).toEqual([]);
  });

  test('a run with no item reads no trigger file, so a malformed one cannot fail it', async () => {
    const directory = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-')));
    await writeFile(join(directory, 'broken.json'), '{ not json');
    const dependencies = {
      triggersDirectory: () => directory,
      getItem: async () => ITEM,
      projectKeyOf: async () => ITEM.projectKey,
      endedCheckout: noCheckout,
    };
    const noItem = endedRun({ item_id: null });
    expect(await createRunEndedStarts(dependencies)(facts({ run: noItem }))).toEqual([]);
    const preflight = createRunEndedPreflight({
      ...dependencies,
      providers: providerRegistry,
      loadConfig: () => Promise.reject(new Error('a run with no item loads no config')),
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
    expect(await starts(facts())).toEqual([]);
  });

  test('no triggers directory starts nothing', async () => {
    const starts = createRunEndedStarts({
      triggersDirectory: () => join(tmpdir(), `archon-no-triggers-${crypto.randomUUID()}`),
      getItem: async () => ITEM,
      projectKeyOf: async () => ITEM.projectKey,
      endedCheckout: noCheckout,
    });
    expect(await starts(facts())).toEqual([]);
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
    const [receipt, ...rest] = await starts(facts());
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
    };
    for (const read of [
      () => createRunEndedStarts(dependencies)(facts()),
      () =>
        createRunEndedPreflight({
          ...dependencies,
          providers: providerRegistry,
          loadConfig: () => Promise.reject(new Error('not reached')),
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
    const receipts = await starts(facts());
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
    const [receipt] = await starts(facts());
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

  // A stale file for another project must not fail item runs of its workflow here.
  test('a launch from a checkout that no longer exists is in no project', async () => {
    const present = track(await mkdtemp(join(tmpdir(), 'archon-run-ended-cwd-')));
    const projectKeyOf = launchProjectKey(async () => ITEM.projectKey);
    expect(await projectKeyOf(present)).toBe(ITEM.projectKey);
    expect(await projectKeyOf(join(present, 'deleted'))).toBeNull();
  });
});
