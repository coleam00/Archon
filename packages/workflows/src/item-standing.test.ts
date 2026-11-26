import { describe, expect, test } from 'bun:test';
import { itemStanding } from './item-standing';
import type { WorkflowRun } from './schemas/workflow-run';

type Run = Parameters<typeof itemStanding>[0]['runs'][number];

function run(
  id: string,
  status: WorkflowRun['status'],
  extra: { outcome?: string; metadata?: Record<string, unknown> } = {}
): Run {
  return {
    id,
    status,
    outcome: null,
    completed_outcome: extra.outcome ?? null,
    metadata: extra.metadata ?? {},
  };
}

/** What a run records at dispatch; `pack_workflow` is absent on runs from older builds. */
const dispatch = (pack: string, workflow?: string): Record<string, unknown> => ({
  dispatch: {
    base_branch: 'dev',
    pack,
    ...(workflow === undefined ? {} : { pack_workflow: workflow }),
  },
});

function standing(
  runs: Run[],
  facts: {
    merged?: boolean;
    ended?: boolean;
    parts?: { done: boolean }[];
    dependsOn?: { done: boolean }[];
    stopped?: boolean;
  } = {}
) {
  return itemStanding({
    runs,
    queued: [],
    held: [],
    waits: [],
    questions: facts.stopped === true ? [{ kind: 'stopped' }] : [],
    merged: facts.merged ?? false,
    ended: facts.ended ?? false,
    parts: facts.parts ?? [],
    dependsOn: facts.dependsOn ?? [],
  });
}

describe('where an item stands', () => {
  test('a merged change is done, whatever its last run did', () => {
    expect(standing([run('r1', 'failed')], { merged: true }).state).toBe('done');
  });

  test('a last run an operator cancelled leaves the item at rest, not failed', () => {
    expect(
      standing([run('r1', 'completed', { outcome: 'built' }), run('r2', 'cancelled')])
    ).toEqual({ runId: 'r2', state: 'resting', pack: null });
  });

  test('a failed run that a later run superseded does not fail the item', () => {
    // Standing reads only that a newer run follows; a superseding run is such a run.
    const rerun = run('r2', 'completed');
    expect(standing([run('r1', 'failed'), rerun]).state).toBe('resting');
  });

  test('a start that failed, or ended with an outcome nothing followed, needs a decision', () => {
    expect(standing([run('r1', 'failed')]).state).toBe('failed');
    expect(standing([run('r1', 'completed', { outcome: 'refused' })]).state).toBe('stopped');
  });

  test('an item is done when every part is done, and not by having no parts', () => {
    const split = [run('r1', 'completed', { outcome: 'split' })];
    expect(standing(split, { parts: [{ done: true }, { done: true }] }).state).toBe('done');
    expect(standing(split).state).toBe('stopped');
  });

  test('an item that split into parts never needs a decision of its own while they go on', () => {
    const parts = [{ done: true }, { done: false }];
    // Live 199: its split ended 'split' and nothing followed; its work goes on in its parts.
    const split = [run('r1', 'completed', { outcome: 'split' })];
    expect(standing(split, { parts }).state).toBe('resting');
    expect(standing(split, { parts, stopped: true }).state).toBe('resting');
    expect(standing([run('r1', 'failed')], { parts }).state).toBe('resting');
    expect(standing([run('r1', 'running')], { parts }).state).toBe('running');
  });

  test('an item that waits on an item it depends on is waiting, not in need of a decision', () => {
    // Live 198: its link stage ended 'waiting' because 196, which it depends on, is open.
    const linked = [run('r1', 'completed', { outcome: 'waiting' })];
    expect(standing(linked, { dependsOn: [{ done: false }] }).state).toBe('waiting');
    expect(standing(linked, { dependsOn: [{ done: false }], stopped: true }).state).toBe('waiting');
    // Once what it depends on is done, nothing moves it but a decision; a failure stays one.
    expect(standing(linked, { dependsOn: [{ done: true }] }).state).toBe('stopped');
    expect(standing([run('r1', 'failed')], { dependsOn: [{ done: false }] }).state).toBe('failed');
  });

  test('the pack is the key its standing run recorded, even without the workflow name', () => {
    const runs = [
      run('r1', 'completed', { metadata: dispatch('flow', 'build') }),
      run('r2', 'completed', { outcome: 'built', metadata: dispatch('other') }),
    ];
    expect(standing(runs).pack).toBe('other');
  });

  test('a standing run that recorded no pack counts for the newest pack its other runs did', () => {
    const runs = [
      run('r1', 'completed', { metadata: dispatch('old') }),
      run('r2', 'completed', { metadata: dispatch('flow', 'build') }),
      run('r3', 'completed', { outcome: 'landed' }),
    ];
    expect(standing(runs)).toMatchObject({ runId: 'r3', pack: 'flow' });
    expect(standing([run('r1', 'completed')]).pack).toBeNull();
    expect(standing([]).pack).toBeNull();
  });
});
