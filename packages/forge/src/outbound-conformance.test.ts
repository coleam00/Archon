import { expect, test } from 'bun:test';
import {
  summarizeChecks,
  type CheckObservation,
  type ForgeResponse,
  type PluginMetadata,
} from './operations';
import {
  runForgeOverviewConformance,
  runForgeReadConformance,
  type ForgeOverviewConformanceCase,
  type ForgeReadConformanceCase,
} from './outbound-conformance';

const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 1 };
const check: CheckObservation = {
  unit: { kind: 'check', id: '42', name: 'build' },
  nativeState: 'completed',
  phase: 'completed',
  nativeResult: 'success',
  result: 'success',
  state: 'green',
  rerun: { id: 'build-run', attempt: 2 },
};
const fixture: ForgeReadConformanceCase = {
  name: 'build',
  request: { operationId: 'observe', op: 'checks.state', ref },
  expected: {
    revision: 'head',
    state: 'green',
    approvalPending: false,
    units: [{ ...check.unit, rerun: check.rerun }],
  },
};

function observation(units: CheckObservation[]): ForgeResponse {
  return {
    operationId: 'observe',
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref,
        revision: 'head',
        units,
        summary: summarizeChecks(units),
        required: null,
        approvalPending: false,
      },
    },
  };
}

test('read conformance accepts matching unit identity and rerun attempt', async () => {
  expect(await runForgeReadConformance(async () => observation([check]), [fixture])).toEqual([]);
});

test('read conformance keeps every unit failure in fixture order', async () => {
  const missing = { ...check.unit, id: 'missing', rerun: null };
  expect(
    await runForgeReadConformance(
      async () => observation([{ ...check, rerun: null }]),
      [
        {
          ...fixture,
          expected: { ...fixture.expected, units: [...fixture.expected.units, missing] },
        },
      ]
    )
  ).toEqual([
    'build: rerun identity or attempt differs',
    'build: rerun identity or attempt differs',
    'build: enumerated unit identities differ',
  ]);
});

const repo = ref.repo;
const overviewMetadata = {
  protocol: 1,
  name: 'test',
  version: '1',
  forge: 'test',
  hosts: [repo.host],
  capabilities: ['repo.overview'],
  token_env: [],
} satisfies PluginMetadata;
const overviewCase: ForgeOverviewConformanceCase = {
  name: 'overview',
  request: { operationId: 'overview', op: 'repo.overview', repo, since: '2026-11-20T00:00:00Z' },
  expected: {
    counts: { issues_open: 2, prs_open: 0 },
    absent: ['prs_draft'],
    pullRequests: undefined,
    issues: [7, 4],
  },
};
const listUrl = 'https://forge.example/owner/repo/issues';
const listed = (number: number) => ({
  ref: { repo, number },
  kind: 'issue' as const,
  url: `${listUrl}/${String(number)}`,
  state: 'open' as const,
  title: `Issue ${String(number)}`,
  updatedAt: '2026-11-21T00:00:00Z',
});
function overview(value: object): ForgeResponse {
  return {
    operationId: 'overview',
    ok: true,
    result: {
      op: 'repo.overview',
      value: {
        repo,
        since: overviewCase.request.since,
        url: 'https://forge.example/owner/repo',
        name: 'owner/repo',
        stats: {
          issues_open: { count: 2, url: listUrl },
          prs_open: { count: 0, url: listUrl },
        },
        issues: [listed(7), listed(4)],
        ...value,
      },
    },
  };
}
const overviewFailures = (value: object) =>
  runForgeOverviewConformance(async () => overview(value), overviewMetadata, [overviewCase]);

test('overview conformance accepts the counts, absences and lists the fixture set up', async () => {
  expect(await overviewFailures({})).toEqual([]);
});

test('overview conformance reports a wrong count, an invented stat and a missing item', async () => {
  expect(
    await overviewFailures({
      stats: {
        issues_open: { count: 3, url: listUrl },
        prs_draft: { count: 0, url: listUrl },
      },
      issues: [listed(7)],
    })
  ).toEqual([
    'overview: issues_open expected 2, received 3',
    'overview: prs_open expected 0, received undefined',
    'overview: prs_draft is reported but the fixture has no such fact',
    'overview: listed issues differ',
  ]);
  expect(await overviewFailures({ repo: { ...repo, path: 'other/repo' } })).toEqual([
    'overview: no valid overview of the requested repository',
  ]);
});
