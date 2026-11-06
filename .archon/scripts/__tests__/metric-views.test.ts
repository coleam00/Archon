/**
 * The pack's overview cards name only metrics its scripts emit, with the kinds the card
 * shapes read: a misspelled or renamed metric would otherwise show "not recorded" forever.
 */
import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prMetricRecords, type PrFacts } from '../../workflows/sdlc/.shared/factory-prs';
import { judgeSlots, scoreCalibration, testValueRecords } from '../../workflows/sdlc/.shared/test-value';

const PR = 'https://github.example.com/acme/widgets/pull/1';
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
const AT = '2026-10-05T12:00:00Z';

function pr(number: number, facts: Partial<PrFacts>): PrFacts {
  return {
    url: `https://github.example.com/acme/widgets/pull/${String(number)}`,
    state: 'OPEN',
    createdAt: AT,
    mergedAt: null,
    closedAt: null,
    headRefName: `build/${String(number)}-widget-aaaaaaaa`,
    isCrossRepository: false,
    ...facts,
  };
}

/** Every record the pack's emitters make, from inputs that reach each of their branches. */
function emitted(): Map<string, { kind: unknown; calibrates: unknown }> {
  const prs = [pr(1, { state: 'MERGED', mergedAt: AT }), pr(2, { state: 'CLOSED', closedAt: AT })];
  const runsByUrl = new Map(prs.map(row => [row.url, [RUN]]));
  const verdict = { file: 'a.test.ts', name: 'logs the probe', protects: false, reason: 'why' };
  const judged = judgeSlots([{ url: PR, merged_at: AT, runs: [RUN] }], [{ tests: [verdict] }]);
  const labeled = { pr: PR, tests: [{ file: 'a.test.ts', name: 'logs the probe', protects: false }] };
  const records: { name?: unknown; kind?: unknown; calibrates?: unknown }[] = [
    ...prMetricRecords(prs, runsByUrl),
    ...testValueRecords(judged, 'judge:abc').metrics,
    ...scoreCalibration(judgeSlots([labeled], [{ tests: [verdict] }]), 'judge:abc').metrics,
  ];
  return new Map(records.map(record => [String(record.name), { kind: record.kind, calibrates: record.calibrates }]));
}

interface Declaration {
  names: Record<string, string>;
  cards: Record<string, unknown>[];
}

it('every metric the declaration names is one the pack emits, and every counted slot is a count', () => {
  const path = join(import.meta.dir, '../../workflows/sdlc/.shared/metric-views.json');
  const declaration = JSON.parse(readFileSync(path, 'utf8')) as Declaration;
  const metrics = emitted();
  expect(Object.keys(declaration.names).filter(name => !metrics.has(name))).toEqual([]);

  const counted = declaration.cards.flatMap(card => [
    card.metric,
    card.numerator,
    card.denominator,
    card.cost_of,
    ...((card.breakdown as { metric: string }[] | undefined) ?? []).map(item => item.metric),
  ]);
  const notCounts = counted.filter(name => name !== undefined && metrics.get(String(name))?.kind !== 'count');
  expect(notCounts).toEqual([]);

  for (const card of declaration.cards) {
    const calibration = card.calibration as { metric: string } | undefined;
    if (calibration === undefined) continue;
    expect(metrics.get(calibration.metric)).toEqual({ kind: 'score', calibrates: card.numerator });
  }
});
