/**
 * The PR metrics' attribution and outcome mapping: which pull requests count, which
 * runs each is attributed to, and which records its state makes.
 */
import { describe, expect, it } from 'bun:test';
import { factoryPrs, prMetricRecords, type PrFacts } from '../../workflows/sdlc/.shared/factory-prs';

const REPO = { host: 'github.example.com', path: 'acme/widgets' };
const RUN_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RUN_C = 'cccccccc-0000-4000-8000-000000000003';

function url(number: number): string {
  return `https://${REPO.host}/${REPO.path}/pull/${String(number)}`;
}

function pr(number: number, facts: Partial<PrFacts> = {}): PrFacts {
  return {
    url: url(number),
    state: 'OPEN',
    createdAt: '2026-10-03T10:00:00Z',
    mergedAt: null,
    closedAt: null,
    headRefName: `build/${String(number)}-widget-aaaaaaaa`,
    isCrossRepository: false,
    ...facts,
  };
}

describe('factoryPrs', () => {
  it('leaves continued pull requests out and reports them as skipped', () => {
    const fork = pr(11, { isCrossRepository: true });
    const handMade = pr(12, { headRefName: 'fix/widget' });
    const { factory, skipped } = factoryPrs([pr(10), fork, handMade]);
    expect(factory.map(row => row.url)).toEqual([url(10)]);
    expect(skipped).toEqual([url(11), url(12)]);
  });
});

describe('prMetricRecords', () => {
  const runsByUrl = new Map([
    [url(10), [RUN_A, RUN_B]],
    [url(11), [RUN_C]],
    [url(12), [RUN_A]],
  ]);

  it('records a merged pull request as opened, merged and not abandoned, with a rate of 1 at its merge time', () => {
    const merged = pr(10, { state: 'MERGED', mergedAt: '2026-10-05T12:00:00Z', closedAt: '2026-10-05T12:00:00Z' });
    expect(prMetricRecords([merged], runsByUrl)).toEqual([
      { name: 'sdlc.prs_opened', kind: 'count', unit: 'prs', value: 1, subject: url(10), at: '2026-10-03T10:00:00Z', runs: [RUN_A, RUN_B] },
      { name: 'sdlc.prs_merged', kind: 'count', unit: 'prs', value: 1, subject: url(10), at: '2026-10-05T12:00:00Z', runs: [RUN_A, RUN_B] },
      { name: 'sdlc.prs_abandoned', kind: 'count', unit: 'prs', value: 0, subject: url(10), at: '2026-10-05T12:00:00Z', runs: [RUN_A, RUN_B] },
      { name: 'sdlc.pr_merge_rate', kind: 'score', unit: 'ratio', value: 1, subject: url(10), at: '2026-10-05T12:00:00Z', runs: [RUN_A, RUN_B] },
    ]);
  });

  it('records a pull request closed without merging as abandoned with a rate of 0, and an open one as opened and not abandoned', () => {
    const closed = pr(11, { state: 'CLOSED', closedAt: '2026-10-06T08:00:00Z' });
    const records = prMetricRecords([closed, pr(12)], runsByUrl);
    expect(records.map(({ name, value, subject, at }) => ({ name, value, subject, at }))).toEqual([
      { name: 'sdlc.prs_opened', value: 1, subject: url(11), at: '2026-10-03T10:00:00Z' },
      { name: 'sdlc.prs_abandoned', value: 1, subject: url(11), at: '2026-10-06T08:00:00Z' },
      { name: 'sdlc.pr_merge_rate', value: 0, subject: url(11), at: '2026-10-06T08:00:00Z' },
      { name: 'sdlc.prs_opened', value: 1, subject: url(12), at: '2026-10-03T10:00:00Z' },
      { name: 'sdlc.prs_abandoned', value: 0, subject: url(12), at: '2026-10-03T10:00:00Z' },
    ]);
  });
});
