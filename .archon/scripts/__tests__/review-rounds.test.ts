/**
 * Review rounds to Ready: which verdicts a build run's artifacts count as rounds, where
 * the count stops, and which merged pull requests are skipped rather than counted short.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrFacts } from '../../workflows/sdlc/.shared/factory-prs';
import {
  readRunVerdicts,
  reviewRoundRecords,
  roundsToReady,
  type RunVerdicts,
  type Verdict,
} from '../../workflows/sdlc/.shared/review-rounds';
import { trackTempRoots } from './temp-roots';

const tracked = trackTempRoots();
const RUN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function verdicts(...ready: boolean[]): Verdict[] {
  return ready.map((value, index) => ({ at: `2026-11-06T10:${String(index).padStart(2, '0')}:00Z`, ready: value }));
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

describe('readRunVerdicts', () => {
  function sidecar(run: string, id: string, meta: Record<string, unknown>, content: unknown): void {
    mkdirSync(join(run, 'nodes'), { recursive: true });
    const path = `nodes/${id}.md`;
    writeFileSync(join(run, path), JSON.stringify(content));
    writeFileSync(join(run, 'nodes', `${id}.meta.json`), JSON.stringify({ path, ...meta }));
  }

  it('reads the review and rereview publish verdicts, not synthesize or other typed outputs', () => {
    const run = tracked(mkdtempSync(join(tmpdir(), 'review-rounds-')));
    const at = '2026-11-06T10:00:00Z';
    sidecar(run, 'a', { nodeId: 'review__publish', outputType: 'review-report', producedAt: at }, { ready: false });
    sidecar(run, 'b', { nodeId: 'review__synthesize', outputType: 'review-report', producedAt: at }, { ready: false });
    sidecar(run, 'c', { nodeId: 'rereview__publish', outputType: 'review-report', producedAt: at }, { ready: true });
    sidecar(run, 'd', { nodeId: 'review__publish', outputType: 'pr-record', producedAt: at }, { ready: true });
    const read = readRunVerdicts(run);
    expect(read.ok && [...read.verdicts].sort((l, r) => Number(l.ready) - Number(r.ready))).toEqual([
      { at, ready: false },
      { at, ready: true },
    ]);
  });

  it('reports a run whose artifacts are gone or whose verdict is unreadable', () => {
    const root = tracked(mkdtempSync(join(tmpdir(), 'review-rounds-')));
    expect(readRunVerdicts(join(root, RUN_A))).toMatchObject({ ok: false });
    sidecar(root, 'a', { nodeId: 'review__publish', outputType: 'review-report', producedAt: 'x' }, { verdict: 'ready' });
    expect(readRunVerdicts(root)).toMatchObject({ ok: false });
  });
});

describe('reviewRoundRecords', () => {
  const ok = (...ready: boolean[]): RunVerdicts => ({ ok: true, verdicts: verdicts(...ready) });

  it('counts a merged pull request across its build runs and records each share', () => {
    const runs = new Map([[pr(1).url, [RUN_A, RUN_B]]]);
    // The second run's verdicts come later than the first's.
    const byRun: Record<string, RunVerdicts> = {
      [RUN_A]: ok(false, false),
      [RUN_B]: { ok: true, verdicts: [{ at: '2026-11-06T11:00:00Z', ready: true }] },
    };
    const result = reviewRoundRecords([pr(1)], runs, new Set(), id => byRun[id] as RunVerdicts);
    expect(result.metrics.map(record => [record.name, record.value])).toEqual([
      ['sdlc.review_rounds', 3],
      ['sdlc.review_one_round', 0],
      ['sdlc.review_five_plus_rounds', 0],
    ]);
    expect(result.metrics[0]).toMatchObject({ kind: 'score', subject: pr(1).url, at: pr(1).mergedAt, runs: [RUN_A, RUN_B] });
    expect(result.distribution).toEqual({ '3': 1 });
  });

  it('skips, with a reason, what it cannot count, and measures no open pull request', () => {
    const prs = [pr(1), pr(2), pr(3), pr(4, { state: 'OPEN', mergedAt: null })];
    // Each pull request's own run, named by its number.
    const runs = new Map(prs.map((row, index) => [row.url, [String(index + 1).repeat(32)]]));
    const byRun: Record<string, RunVerdicts> = { ['2'.repeat(32)]: { ok: false, problem: 'gone' }, ['3'.repeat(32)]: ok(true, false) };
    const result = reviewRoundRecords(prs, runs, new Set([pr(1).url]), id => byRun[id] ?? ok(true));
    expect(result.metrics).toEqual([]);
    expect(result.skipped.map(entry => entry.url)).toEqual([pr(1).url, pr(2).url, pr(3).url]);
  });
});
