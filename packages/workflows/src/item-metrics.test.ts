import { describe, expect, test } from 'bun:test';
import type { ItemRead, ItemRun } from './item-read';
import { evaluateItemMetrics } from './item-metrics';
import type { ItemMetricDefinition } from './schemas/item-metric';

function run(workflow: string, startedAt: string, outcome: string | null = null): ItemRun {
  return {
    id: `${workflow}-${startedAt}`,
    workflow,
    pack: null,
    status: 'completed',
    outcome,
    startedAt,
    completedAt: startedAt,
    cause: null,
    awaitingExecution: null,
    startLimit: null,
    spend: { usd: null, inputTokens: null, outputTokens: null },
    heldBehind: null,
    operatorPause: null,
    hasResult: false,
    resultCommit: null,
    changeSize: null,
  };
}

function read(key: string, runs: ItemRun[], mergedAt: string | null): ItemRead {
  return {
    item: { id: key, projectKey: 'acme/web', key },
    runs,
    queued: [],
    skipped: [],
    hold: null,
    runLimit: null,
    startLimits: [],
    waits: [],
    held: [],
    questions: [],
    answers: [],
    links: [],
    landing: null,
    merged:
      mergedAt === null
        ? null
        : {
            change: `https://forge.example/${key}`,
            commit: null,
            at: mergedAt,
            recordedAt: mergedAt,
            via: 'cli',
            fromRun: null,
          },
    degraded: [],
  };
}

// a: built, reviewed twice, merged 10 hours after its first run. b: built, reviewed once,
// merged 4 hours after. c: built and still under review, not merged.
const reads = [
  read(
    'a',
    [
      run('build', '2026-11-01T00:00:00.000Z', 'built'),
      run('review', '2026-11-01T02:00:00.000Z', 'changes'),
      run('review', '2026-11-01T05:00:00.000Z', 'approved'),
    ],
    '2026-11-01T10:00:00.000Z'
  ),
  read(
    'b',
    [
      run('build', '2026-11-02T00:00:00.000Z', 'built'),
      run('review', '2026-11-02T01:00:00.000Z', 'approved'),
    ],
    '2026-11-02T04:00:00.000Z'
  ),
  read(
    'c',
    [run('build', '2026-11-03T00:00:00.000Z', 'built'), run('review', '2026-11-03T01:00:00.000Z')],
    null
  ),
];

const evaluate = (definition: ItemMetricDefinition) => evaluateItemMetrics([definition], reads)[0];

describe('item metrics', () => {
  test('merge rate is the share of items that carry the merged fact', () => {
    expect(evaluate({ name: 'merge_rate', op: 'share', where: { merged: true } })).toEqual({
      name: 'merge_rate',
      op: 'share',
      value: 2 / 3,
      numerator: 2,
      denominator: 3,
    });
  });

  test('review rounds per merged item counts the declared workflow over merged items only', () => {
    expect(
      evaluate({
        name: 'rounds',
        op: 'count',
        of: 'runs',
        runs: { workflow: ['review'] },
        items: { merged: true },
      })
    ).toEqual({ name: 'rounds', op: 'count', value: 1.5, total: 3, n: 2 });
  });

  test('a duration is the mean over items with both times, and the rest are missing', () => {
    expect(
      evaluate({
        name: 'lead_time',
        op: 'duration',
        from: { run: 'first', at: 'started' },
        to: 'merged',
      })
    ).toEqual({ name: 'lead_time', op: 'duration', value: 7, unit: 'hours', n: 2, missing: 1 });
  });

  test('a grouped figure is reported per group beside the whole', () => {
    const result = evaluate({
      name: 'merged_by_last_outcome',
      op: 'share',
      where: { merged: true },
      group_by: 'last_run.outcome',
    });
    expect(result?.groups).toEqual([
      { group: 'approved', op: 'share', value: 1, numerator: 2, denominator: 2 },
      { group: null, op: 'share', value: 0, numerator: 0, denominator: 1 },
    ]);
  });

  test('an empty population has no value', () => {
    expect(
      evaluateItemMetrics([{ name: 'none', op: 'share', where: { merged: true } }], [])[0]
    ).toEqual({ name: 'none', op: 'share', value: null, numerator: 0, denominator: 0 });
  });
});
