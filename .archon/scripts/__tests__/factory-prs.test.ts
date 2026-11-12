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
} }));
`;
const resolved = forgeOperation('resolve', {
  kind: 'resolved', forge: 'fake', repo: PR.repo, subject: { kind: 'pr', number: PR.number },
  plugin: { protocol: 1, name: 'fake', version: '1', forge: 'fake', hosts: [PR.repo.host], capabilities: ['resolve', 'pr.view'] },
});
const failure = () => JSON.stringify({ operationId: 'failed', ok: false,
  error: { kind: 'forge_error', status: 503, message: 'GitHub API request failed with HTTP 503' } });

for (const op of ['resolve', 'pr.view']) {
  test(`metrics name the pull request on a terminal ${op} failure`, () => {
    const run = runner.runPackScript('metrics-prs/scripts/prs', {
      preload, inputs: { INPUTS_SINCE: '2026-11-01' },
      forge: { kind: 'fake', response: op === 'resolve' ? failure() : [resolved, failure()] },
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(PR_URL);
    expect(run.stderr).toContain(`forge ${op} failed: GitHub API request failed with HTTP 503`);
    expect(run.forge).toHaveLength(op === 'resolve' ? 1 : 2);
  });
}

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
    { ...base, name: 'sdlc.issues_built.plan', value: 1, unit: 'issues', subject: `${PR.repo.host}/${PR.repo.path}#42` },
  ]);
  expect(run.forge).toHaveLength(2);
});

test('an unusable PR answer keeps its existing URL diagnostic without wrapping', () => {
  const run = runner.runPackScript('metrics-prs/scripts/prs', {
    preload, inputs: { INPUTS_SINCE: '2026-11-01' },
    forge: { kind: 'fake', response: [resolved, forgeOperation('pr.view', { pr: view.pr })] },
  });
  expect(run.code).not.toBe(0);
  expect(run.stdout).toBe('');
  expect(run.stderr).toBe(`prs: forge pr.view reported no timestamps for ${PR_URL}; PR metrics need a forge plugin whose pr.view reports them\n`);
  expect(run.forge).toHaveLength(2);
});

for (const op of ['resolve', 'pr.view']) {
  test(`metrics name the pull request when the host gives no ${op} answer`, () => {
    const run = runner.runPackScript('metrics-prs/scripts/prs', {
      preload, inputs: { INPUTS_SINCE: '2026-11-01' },
      forge: { kind: 'fake', response: op === 'resolve' ? 'not JSON' : [resolved, 'not JSON'] },
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(PR_URL);
    expect(run.stderr).toContain(`archon forge ${op} failed`);
    expect(run.forge).toHaveLength(op === 'resolve' ? 1 : 2);
  });
}
