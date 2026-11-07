/**
 * The PR metrics' attribution and outcome mapping: which pull requests count, which
 * runs each is attributed to, which records its state makes, and the forge view they
 * are read from.
 */
import { describe, expect, it } from 'bun:test';
import { factoryPrs, prFacts, prMetricRecords, type PrFacts } from '../../workflows/sdlc/.shared/factory-prs';

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

describe('prFacts', () => {
  const view = (pr: Record<string, unknown>, timestamps?: Record<string, unknown>) => ({
    pr: {
      schemaVersion: 1, repo: REPO, number: 10, url: url(10), head: 'build/10-widget-aaaaaaaa', base: 'dev',
      is_draft: false, state: 'merged', head_repo: REPO, head_revision: 'abc', base_revision: null,
      maintainer_can_modify: null, ...pr,
    },
    title: 'A title',
    body: '',
    ...(timestamps === undefined ? {} : { timestamps }),
  });
  const times = { created_at: '2026-10-03T10:00:00Z', merged_at: '2026-10-05T12:00:00Z', closed_at: '2026-10-05T12:00:05Z' };

  it('maps a pr.view to the facts the records read, with a fork head as cross-repository', () => {
    expect(prFacts(url(10), view({}, times))).toEqual(
      pr(10, { state: 'MERGED', mergedAt: times.merged_at, closedAt: times.closed_at })
    );
    const closed = view({ state: 'closed' }, { ...times, merged_at: null });
    expect(prFacts(url(10), closed)).toEqual(pr(10, { state: 'CLOSED', mergedAt: null, closedAt: times.closed_at }));
    const fork = view({ state: 'open', head_repo: { host: REPO.host, path: 'someone/widgets' } }, { ...times, merged_at: null, closed_at: null });
    expect(prFacts(url(10), fork)).toMatchObject({ state: 'OPEN', isCrossRepository: true });
  });

  it('refuses a view without timestamps, naming them, and a view of no pull request', () => {
    expect(() => prFacts(url(10), view({}))).toThrow(`forge pr.view reported no timestamps for ${url(10)}`);
    expect(() => prFacts(url(10), null)).toThrow(`forge pr.view reported no pull request for ${url(10)}`);
  });
});

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
