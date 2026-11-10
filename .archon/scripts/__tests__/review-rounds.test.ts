/**
 * Review rounds to Ready: which verdicts a run records, where the count stops, the
 * backfill for older rounds, and which merged pull requests are skipped rather than
 * counted short.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildRound, KEPT_ROUNDS, type ReviewVerdict } from '../../workflows/sdlc/.shared/build';
import type { PrFacts } from '../../workflows/sdlc/.shared/factory-prs';
import type { WorkItem } from '../../workflows/sdlc/.shared/workitem';
import {
  REVIEW_NODES,
  droppedRoundPrs,
  reviewRoundRecords,
  roundsToReady,
  type RunReviews,
} from '../../workflows/sdlc/.shared/review-rounds';
import { PACK } from './deliver-checks-harness';

const RUN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function verdicts(...ready: boolean[]): ReviewVerdict[] {
  return ready.map((value, index) => ({ ready: value, at: `2026-11-06T10:${String(index).padStart(2, '0')}:00Z` }));
}

function pr(number: number, facts: Partial<PrFacts> = {}): PrFacts {
  return {
    url: `https://github.example.com/acme/widgets/pull/${String(number)}`,
    state: 'MERGED',
    createdAt: '2026-11-06T09:00:00Z',
    mergedAt: '2026-11-06T12:00:00Z',
    closedAt: '2026-11-06T12:00:00Z',
    headRefName: `build/${String(number)}-widget-aaaaaaaa`,
    isCrossRepository: false,
    ...facts,
  };
}

function round(runId: string, url: string, reviews?: readonly ReviewVerdict[]): BuildRound {
  return { run_id: runId, at: '2026-11-06T11:00:00Z', delivered: true, reason: 'delivered', pr_url: url, summary: '', artifacts: '', ...(reviews === undefined ? {} : { reviews }) };
}

describe('roundsToReady', () => {
  it('counts to the verdict from which every later one is ready, in time order', () => {
    expect(roundsToReady(verdicts(true, true))).toBe(1);
    expect(roundsToReady(verdicts(false, true, true))).toBe(2);
    // A Ready review a later review overturned did not end the review.
    expect(roundsToReady(verdicts(false, true, false, false, true, true))).toBe(5);
    expect(roundsToReady(verdicts(false, true).reverse())).toBe(2);
  });

  it('has no count while the latest verdict is not ready, or without verdicts', () => {
    expect(roundsToReady(verdicts(true, false))).toBeNull();
    expect(roundsToReady([])).toBeNull();
  });
});

interface Node {
  readonly id: string;
  readonly include?: string;
  readonly script?: string;
  readonly output_type?: string;
  readonly loop_group?: { readonly nodes: readonly Node[] };
}

function nodesOf(path: string): Node[] {
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, path), 'utf8')) as { nodes: Node[] };
  const walk = (nodes: readonly Node[]): Node[] => nodes.flatMap(node => [node, ...walk(node.loop_group?.nodes ?? [])]);
  return walk(workflow.nodes);
}

describe('REVIEW_NODES', () => {
  it('names the published verdict of every review the deliver loop includes', () => {
    const reviews = nodesOf('deliver/archon-deliver.yaml').filter(node => node.include === 'archon-review');
    // synthesize's verdict is the agent's; the published one is the script node that writes it to the pull request.
    const published = nodesOf('review/archon-review.yaml').filter(
      node => node.output_type === 'review-report' && node.script !== undefined
    );
    expect(reviews.length).toBeGreaterThan(0);
    expect(published).toHaveLength(1);
    expect([...REVIEW_NODES].sort()).toEqual(reviews.map(review => `${review.id}__${published[0]?.id}`).sort());
  });
});

describe('reviewRoundRecords', () => {
  const unused = (runIds: readonly string[]): Map<string, RunReviews> => {
    if (runIds.length > 0) throw new Error('a round that carries its verdicts needs no backfill');
    return new Map();
  };

  it('counts a merged pull request across its build rounds and records each share', () => {
    const url = pr(1).url;
    const rounds = new Map([[url, [round(RUN_A, url, verdicts(false, false)), round(RUN_B, url, [{ ready: true, at: '2026-11-06T11:00:00Z' }])]]]);
    const result = reviewRoundRecords([pr(1)], new Map([[url, [RUN_A, RUN_B]]]), rounds, new Set(), unused);
    expect(result.metrics.map(record => [record.name, record.value])).toEqual([
      ['sdlc.review_rounds', 3],
      ['sdlc.review_one_round', 0],
      ['sdlc.review_five_plus_rounds', 0],
    ]);
    expect(result.metrics[0]).toMatchObject({ kind: 'score', subject: url, at: pr(1).mergedAt, runs: [RUN_A, RUN_B] });
    expect(result.distribution).toEqual({ '3': 1 });
  });

  it('backfills only rounds recorded without verdicts, and skips with a reason what it cannot count', () => {
    const prs = [pr(1), pr(2), pr(3), pr(4), pr(5, { state: 'OPEN', mergedAt: null })];
    // Each pull request's own run, named by its number; none recorded its verdicts.
    const runOf = (index: number) => String(index + 1).repeat(32);
    const runs = new Map(prs.map((row, index) => [row.url, [runOf(index)]]));
    const rounds = new Map(prs.map((row, index) => [row.url, [round(runOf(index), row.url)]]));
    const byRun: Record<string, RunReviews> = {
      [runOf(1)]: { ok: false, problem: 'gone' },
      [runOf(2)]: { ok: true, verdicts: verdicts(true, false) },
      [runOf(3)]: { ok: true, verdicts: verdicts(false, true) },
    };
    const result = reviewRoundRecords(prs, runs, rounds, new Set([pr(1).url]), ids => new Map(ids.map(id => [id, byRun[id] ?? { ok: true, verdicts: verdicts(true) }])));
    expect(result.skipped.map(entry => entry.url)).toEqual([pr(1).url, pr(2).url, pr(3).url]);
    expect(result.metrics.filter(record => record.name === 'sdlc.review_rounds').map(record => [record.subject, record.value])).toEqual([[pr(4).url, 2]]);
  });

  it('treats every pull request on a work item at the round cap as possibly missing rounds', () => {
    const [a, b] = [pr(1).url, pr(2).url];
    // A returned to after B: the dropped rounds before the oldest kept one may have carried either.
    const urls = [b, ...Array<string>(KEPT_ROUNDS - 2).fill(a), ''];
    const capped = { facts: { build: { rounds: urls.map((url, index) => round(String(index), url)) } } } as unknown as WorkItem;
    expect([...droppedRoundPrs([capped])].sort()).toEqual([a, b]);
    const under = { facts: { build: { rounds: [round(RUN_A, a)] } } } as unknown as WorkItem;
    expect(droppedRoundPrs([under]).size).toBe(0);
  });
});
