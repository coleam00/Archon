import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRunFixture } from './__fixtures__/read-run-fixture';
import {
  factoryShadowDecisionSchema,
  latestShadowDecisions,
  readShadowValue,
  shadowDecisions,
  type FactoryShadowDecision,
} from './factory-shadows';
import { factoryViewSchema, type FactoryShadow } from './schemas/factory-view';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { workflowRunSchema, type WorkflowRun } from './schemas/workflow-run';

const PACK = 'Wirasm/archon-software-factory';
// The declaration this repository ships for the pack the fixtures' runs come from.
const shipped = factoryViewSchema.parse(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '../../../.archon/packs/Wirasm.archon-software-factory.factory-view.json'
      ),
      'utf8'
    )
  )
);
/**
 * The merge gate as the shipped view declared it while it was a shadow, when #70's landgate run
 * recorded its decision. The view no longer declares it (the gate acts now), so the reader is
 * shown it here.
 */
const GATE_SHADOW: FactoryShadow = {
  workflow: 'landgate',
  node: 'gate',
  label: 'Would it merge on its own',
  reads: 'verdict',
  pointer: '/land',
  why: '/why',
  words: { auto: 'would merge on its own', ask: 'would ask you first' },
};
const view = factoryViewSchema.parse({
  ...shipped,
  shadows: [...(shipped.shadows ?? []), GATE_SHADOW],
});

interface Fixture {
  run: WorkflowRun;
  events: WorkflowEventRow[];
}

/** Runs copied from the live factory database: each file's `note` says which. */
function fixture(name: string): Fixture {
  const raw = readRunFixture(
    join(import.meta.dir, '__fixtures__', 'factory-shadows', `${name}.jsonl`)
  ) as ReturnType<typeof readRunFixture> & {
    run: Record<string, unknown> & {
      started_at: string;
      completed_at: string | null;
      last_activity_at: string | null;
    };
  };
  const date = (value: string | null): Date | null => (value === null ? null : new Date(value));
  const run = workflowRunSchema.parse({
    origin: null,
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    outcome: null,
    completed_outcome: null,
    user_message: '',
    active_phase_started_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
    metadata: {},
    ...raw.run,
    started_at: new Date(raw.run.started_at),
    completed_at: date(raw.run.completed_at),
    last_activity_at: date(raw.run.last_activity_at),
  });
  return { run, events: raw.events };
}

const decisionsOf = ({ run, events }: Fixture): FactoryShadowDecision[] =>
  shadowDecisions(view, PACK, run, events);

const triage65 = fixture('item-65-triage');
const deliver65 = fixture('item-65-deliver');
const failedChecks = fixture('failed-checks-deliver');
const landgate70 = fixture('item-70-landgate');
const discoveries70 = fixture('item-70-discoveries');

/** `fix`'s run with its completed `node` event's data changed by `change`. */
function withCompleted(
  fix: Fixture,
  node: string,
  change: (data: Record<string, unknown>) => Record<string, unknown>
): Fixture {
  return {
    run: fix.run,
    events: fix.events.map(row =>
      row.step_name === node && row.event_type === 'node_completed'
        ? { ...row, data: change(row.data as Record<string, unknown>) }
        : row
    ),
  };
}

describe('reading what each shadow step recorded', () => {
  test('#65 triage: admit would start on its own; its old split step is no declared shadow', () => {
    const decisions = decisionsOf(triage65);
    for (const decision of decisions) factoryShadowDecisionSchema.parse(decision);
    // The run recorded a split step too; split is a workflow of its own now, and the view
    // declares no shadow on triage's old step, so it is not read.
    expect(decisions.map(({ node, round, read }) => ({ node, round, reads: read.reads }))).toEqual([
      { node: 'admit', round: null, reads: 'verdict' },
    ]);
    const admit = decisions.find(decision => decision.node === 'admit');
    expect(admit?.read).toMatchObject({ reads: 'verdict', value: 'auto' });
    expect(admit?.read.reads === 'verdict' ? admit.read.why : null).toStartWith(
      'The item is ordered by work order #64'
    );
    expect(admit).toMatchObject({
      workflow: 'triage',
      runId: triage65.run.id,
      decidedAt: '2026-11-18T15:57:55.000Z',
    });
  });

  test('#65 deliver: one project checks decision per round, read from text output', () => {
    const decisions = decisionsOf(deliver65);
    expect(decisions.map(decision => [decision.node, decision.round])).toEqual([
      ['rounds.checks', 1],
      ['rounds.checks', 2],
      ['rounds.checks', 3],
    ]);
    expect(decisions[0]?.read).toEqual({
      reads: 'checks',
      results: [
        { name: 'type-check', passed: true, seconds: 135, tail: null },
        { name: 'lint', passed: true, seconds: 56, tail: null },
        { name: 'format', passed: true, seconds: 1, tail: null },
        { name: 'web tests', passed: true, seconds: 18, tail: null },
      ],
    });
  });

  test('a round whose checks failed names each failed check with its tail', () => {
    const [decision] = decisionsOf(failedChecks);
    expect(decision?.read.reads).toBe('checks');
    const results = decision?.read.reads === 'checks' ? decision.read.results : [];
    expect(results.filter(result => !result.passed).map(result => result.name)).toEqual([
      'type-check',
      'lint',
      'web tests',
    ]);
    expect(results[0]?.tail).toContain('exited with code 1');
    expect(results.find(result => result.passed)?.tail).toBeNull();
  });

  test('#70 land gate: would ask, with its why', () => {
    const [decision] = decisionsOf(landgate70);
    expect(decision).toMatchObject({ workflow: 'landgate', node: 'gate', round: null });
    expect(decision?.read).toMatchObject({ reads: 'verdict', value: 'ask' });
    expect(decision?.read.reads === 'verdict' ? decision.read.why : null).toStartWith(
      'The change adds a new panel'
    );
  });

  test('#70 discoveries: counts each declared list from text output, the summary as why', () => {
    const [decision] = decisionsOf(discoveries70);
    expect(decision).toMatchObject({ workflow: 'discoveries', node: 'result', round: null });
    expect(decision?.read).toMatchObject({ reads: 'lists', counts: [1, 3, 0, 2] });
    expect(decision?.read.reads === 'lists' ? decision.read.why : null).toStartWith('Six reports.');
  });

  test('a run of a workflow no shadow names decides nothing', () => {
    const elsewhere = { ...triage65, run: { ...triage65.run, workflow_name: `${PACK}:plan` } };
    expect(decisionsOf(elsewhere)).toEqual([]);
  });
});

describe('a step with no readable decision', () => {
  test('a skipped step yields no decision', () => {
    const skipped: Fixture = {
      run: landgate70.run,
      events: landgate70.events
        .filter(row => row.event_type === 'node_started')
        .map(row => ({ ...row, event_type: 'node_skipped', data: { reason: 'when_condition' } })),
    };
    expect(decisionsOf(skipped)).toEqual([]);
  });

  test('a step that started and never completed yields no decision', () => {
    const started = {
      run: landgate70.run,
      events: landgate70.events.filter(row => row.event_type === 'node_started'),
    };
    expect(decisionsOf(started)).toEqual([]);
  });

  test('text output that is not JSON is unreadable', () => {
    const prose = withCompleted(discoveries70, 'result', data => ({
      ...data,
      node_output: 'Filed one finding.',
    }));
    expect(decisionsOf(prose).map(decision => decision.read)).toEqual([{ reads: 'unreadable' }]);
  });

  test('text output cut short is unreadable, even when what is left parses', () => {
    const cut = withCompleted(discoveries70, 'result', data => ({
      ...data,
      node_output_truncated: true,
    }));
    expect(decisionsOf(cut).map(decision => decision.read)).toEqual([{ reads: 'unreadable' }]);
  });

  test('a structured value missing the declared verdict is unreadable', () => {
    const empty = withCompleted(landgate70, 'gate', data => ({
      ...data,
      structured_output: { why: 'no verdict' },
    }));
    expect(decisionsOf(empty).map(decision => decision.read)).toEqual([{ reads: 'unreadable' }]);
  });

  test('a check entry without a name or passed flag makes the checks unreadable', () => {
    const shadow = view.shadows?.find(entry => entry.reads === 'checks') as FactoryShadow;
    expect(readShadowValue(shadow, { results: [{ name: 'lint' }] })).toEqual({
      reads: 'unreadable',
    });
    expect(readShadowValue(shadow, { results: 'none' })).toEqual({ reads: 'unreadable' });
  });

  test('a declared list that is not a list makes the lists unreadable', () => {
    const shadow = view.shadows?.find(entry => entry.reads === 'lists') as FactoryShadow;
    expect(readShadowValue(shadow, { filed: [], folded: [], held: [], dropped: 2 })).toEqual({
      reads: 'unreadable',
    });
  });

  test('a verdict the words map lacks is still read, as the pack recorded it', () => {
    const shadow = view.shadows?.find(entry => entry.node === 'gate') as FactoryShadow;
    expect(readShadowValue(shadow, { land: 'maybe' })).toEqual({
      reads: 'verdict',
      value: 'maybe',
      why: null,
    });
  });
});

describe('the newest decision of each shadow', () => {
  test('a later run wins, and within a run its last round', () => {
    const latest = latestShadowDecisions([
      decisionsOf(triage65),
      decisionsOf(failedChecks),
      decisionsOf(deliver65),
      decisionsOf(landgate70),
    ]);
    expect(latest.map(decision => [decision.node, decision.runId, decision.round])).toEqual([
      ['admit', triage65.run.id, null],
      ['rounds.checks', deliver65.run.id, 3],
      ['gate', landgate70.run.id, null],
    ]);
  });
});
