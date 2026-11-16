import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { RunEndedFacts } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createRunEndedStarts } from './run-ended';

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

async function triggersWith(files: Record<string, unknown>) {
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

  test.each([
    ['a run with no item', facts({ run: endedRun({ item_id: null }) })],
    ['a child run', facts({ run: endedRun({ parent_run_id: 'parent' }) })],
    ['another workflow', facts({ run: endedRun({ workflow_name: 'review' }) })],
    ['another outcome', facts({ outcome: { kind: 'enum', value: 'blocked' } })],
  ])('%s starts nothing', async (_label, ended) => {
    const starts = await triggersWith({ 'build.json': trigger() });
    expect(await starts(ended)).toEqual([]);
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
    expect(await starts(facts())).toMatchObject([
      {
        outcome: 'unmatched',
        bindings: [],
        evaluatedBindings: [
          {
            bindingId: 'build',
            status: 'rejected',
            reason: "Input 'plan': result pointer '/missing' did not resolve",
          },
        ],
      },
    ]);
  });

  test.each([
    [
      'reads an input the ended workflow does not declare',
      {
        runEnded: { workflowName: 'plan', outcome: 'planned', inputs: { x: { input: 'secret' } } },
      },
      "reads 'secret', which 'plan' does not declare",
    ],
    [
      'names an outcome the ended workflow cannot complete with',
      { runEnded: { workflowName: 'plan', outcome: 'plannned' } },
      "outcome 'plannned' is not one 'plan' completes with",
    ],
  ])('a binding that %s is refused naming its file', async (_label, on, message) => {
    const starts = await triggersWith({ 'build.json': trigger({ on }) });
    const refused = starts(facts());
    await expect(refused).rejects.toThrow(message);
    await expect(refused).rejects.toThrow('build.json');
  });

  test.each([
    [
      'a file that is not JSON',
      { 'broken.json': '{ not json' },
      'broken.json is not readable JSON',
    ],
    [
      'an invalid on.runEnded',
      { 'build.json': trigger({ on: { runEnded: { workflowName: 'plan' } } }) },
      'build.json is invalid',
    ],
    [
      'two files with one source',
      { 'a.json': trigger(), 'b.json': trigger() },
      "share sourceInstanceId 'build-after-plan'",
    ],
  ])('%s fails the read loudly', async (_label, files, message) => {
    const starts = await triggersWith(files);
    await expect(starts(facts())).rejects.toThrow(message);
  });
});
