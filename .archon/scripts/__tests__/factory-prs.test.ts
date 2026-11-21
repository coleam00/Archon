import { expect, test } from 'bun:test';
import { newWorkItem, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { forgeOperation, forgePrRecord, packScriptRunner, PR, PR_URL } from './deliver-checks-harness';

const runner = packScriptRunner();
const at = '2026-11-10T12:00:00Z';
const runId = 'aaaaaaaa-0000-4000-8000-000000000001';
const item = { ...newWorkItem(PR, at), facts: { build: {
  status: 'ready', brief: '', at, decisions: [],
  rounds: [{ run_id: runId, at, route: 'plan', delivered: true,
    reason: 'delivered', pr_url: PR_URL, summary: '', artifacts: '' }],
} } } satisfies WorkItem;
const preload = `
import { mock } from 'bun:test';
import * as api from 'archon:script';
mock.module('archon:script', () => ({ ...api, state: { ...api.state,
  listValues: () => [{ name: 'work/42', revision: 1, lease: null, value: ${JSON.stringify(item)} }],
  // The run keeps a merged pull request's facts; these tests count only the forge calls.
  put: () => ({ ok: true, revision: 1 }),
} }));
`;
const resolved = forgeOperation('resolve', {
  kind: 'resolved', forge: 'fake', repo: PR.repo, subject: { kind: 'pr', number: PR.number },
  plugin: { protocol: 1, name: 'fake', version: '1', forge: 'fake', hosts: [PR.repo.host], capabilities: ['resolve', 'pr.view'] },
});

const view = {
  pr: forgePrRecord({ head: 'build/widget' }),
  timestamps: { created_at: at, merged_at: null, closed_at: null },
};

test('a successful forge answer produces the complete PR metric records', () => {
  const run = runner.runPackScript('metrics-prs/scripts/prs', {
    preload, inputs: { INPUTS_SINCE: '2026-11-01' },
    forge: { kind: 'fake', response: [resolved, forgeOperation('pr.view', view)] },
  });
  expect(run.code).toBe(0);
  const output = JSON.parse(run.stdout);
  const base = { kind: 'count', unit: 'prs', subject: PR_URL, at,
    runs: [runId] };
  expect(output.metrics).toEqual([
    { ...base, name: 'sdlc.prs_opened', value: 1 },
    { ...base, name: 'sdlc.prs_abandoned', value: 0 },
    { ...base, name: 'sdlc.issues_built', value: 1, unit: 'issues', subject: `${PR.repo.host}/${PR.repo.path}#42` },
  ]);
  expect(output.metric_dimensions).toEqual([{}, {}, { route: 'plan' }]);
  expect(run.forge).toHaveLength(2);
});

test('a PR answer with no timestamps is refused', () => {
  const run = runner.runPackScript('metrics-prs/scripts/prs', {
    preload, inputs: { INPUTS_SINCE: '2026-11-01' },
    forge: { kind: 'fake', response: [resolved, forgeOperation('pr.view', { pr: view.pr })] },
  });
  expect(run.code).not.toBe(0);
  expect(run.stdout).toBe('');
});
