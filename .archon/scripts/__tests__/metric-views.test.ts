/**
 * The pack's overview cards name only metrics its scripts emit, with the kinds the card
 * shapes read: a misspelled or renamed metric would otherwise show "not recorded" forever.
 */
import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueMetricRecords } from '../../workflows/sdlc/.shared/factory-issues';
import { prMetricRecords, type PrFacts } from '../../workflows/sdlc/.shared/factory-prs';
import { reviewRoundRecords } from '../../workflows/sdlc/.shared/review-rounds';
import { judgeSlots, scoreCalibration, testValueRecords } from '../../workflows/sdlc/.shared/test-value';
import { newWorkItem, type WorkItem } from '../../workflows/sdlc/.shared/workitem';

const PR = 'https://github.example.com/acme/widgets/pull/1';
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_RUN = 'bbbbbbbb-0000-4000-8000-000000000002';
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

/** An issue intake saw at AT, built in two rounds on the plan route, merged a day later after one answered ask. */
function mergedIssue(): WorkItem {
  const merged = '2026-10-06T12:00:00Z';
  const round = { run_id: RUN, at: AT, delivered: true, reason: 'delivered', pr_url: PR, summary: '', artifacts: '' };
  const decision = { at: AT, run_id: RUN, decision: 'ask scope', reason: 'r', links: [] };
  return {
    ...newWorkItem({ repo: { host: 'github.example.com', path: 'acme/widgets' }, number: 7 }, AT),
    stage: 'close',
    facts: {
      build: {
        status: 'ready',
        brief: '',
        rounds: [{ ...round, route: 'plan' }, { ...round, run_id: OTHER_RUN, route: 'continue' }],
        decisions: [{ ...decision, answer: { choice: 'go', text: '', at: AT } }, { ...decision, decision: 'ready' }],
        at: AT,
      },
      merge: { status: 'merged', pr: null, approval: null, decisions: [], at: merged },
    },
  };
}

/** Every record the pack's emitters make, from inputs that reach each of their branches. */
function emitted(): Map<string, { kind: unknown; calibrates: unknown }> {
  const prs = [pr(1, { state: 'MERGED', mergedAt: AT }), pr(2, { state: 'CLOSED', closedAt: AT })];
  const runsByUrl = new Map(prs.map(row => [row.url, [RUN]]));
  const round = { run_id: RUN, at: AT, delivered: true, reason: 'delivered', summary: '', artifacts: '', reviews: [{ ready: true, at: AT }] };
  const reviewed = new Map(prs.map(row => [row.url, [{ ...round, pr_url: row.url }]]));
  const verdict = { file: 'a.test.ts', name: 'logs the probe', protects: false, reason: 'why' };
  const judged = judgeSlots([{ url: PR, merged_at: AT, runs: [RUN] }], [{ tests: [verdict] }]);
  const labeled = { pr: PR, tests: [{ file: 'a.test.ts', name: 'logs the probe', protects: false }] };
  const records: { name?: unknown; kind?: unknown; calibrates?: unknown }[] = [
    ...prMetricRecords(prs, runsByUrl),
    ...reviewRoundRecords(prs, runsByUrl, reviewed, new Set(), () => ({ ok: false, problem: 'unused' })).metrics,
    ...testValueRecords(judged, 'judge:abc').metrics,
    ...scoreCalibration(judgeSlots([labeled], [{ tests: [verdict] }]), 'judge:abc').metrics,
    ...issueMetricRecords([mergedIssue()]),
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
