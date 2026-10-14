import { expect, test } from 'bun:test';
import {
  forgeFailure,
  forgeOperation,
  PR,
  packScriptRunner,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const inputs = {
  INPUTS_ITEM: JSON.stringify({ repo: PR.repo, number: 7 }),
  INPUTS_PUBLISH: 'true',
  INPUTS_DECISION: JSON.stringify({ contract: 'READY', route: 'deliver' }),
  INPUTS_COMPLEXITY: 'small',
  INPUTS_SUMMARY: 'Ready',
  INPUTS_AREA_LABELS: '["area","nonexistent"]',
  INPUTS_REPORT: '{"path":"triage.md"}',
};
test('default gh triage applies wanted labels', () => {
  const triage = runPackScript('triage/scripts/verdict', { inputs });
  expect({ code: triage.code, stderr: triage.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(triage.stdout)).toMatchObject({
    published: true,
    labels: ['archon-ready', 'archon-small', 'area'],
  });
  expect(triage.forge).toEqual([]);
  expect(triage.gh.some(call => call.includes('--hostname ghe.example.com'))).toBe(true);
  expect(triage.gh.some(call => call.startsWith('label create nonexistent'))).toBe(false);
});

test('unpublished and non-tracker triage never invoke either transport', () => {
  for (const patch of [
    { INPUTS_PUBLISH: 'false' },
    { INPUTS_ITEM: '{"repo":{"host":"","path":""},"number":0}' },
  ]) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'invalid',
      inputs: { ...inputs, ...patch },
    });
    expect(run.code).toBe(0);
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
    expect(JSON.parse(run.stdout).published).toBe(false);
  }
});

test('a ready item is labelled with the route the run takes on it', () => {
  for (const [decision, label] of [
    [{ contract: 'READY', route: 'plan' }, 'archon-plan'],
    [{ contract: 'READY', route: 'investigate' }, 'archon-issue'],
    [{ contract: 'READY', route: 'continue', pull_request: 3 }, 'archon-ready'],
  ] as const) {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_DECISION: JSON.stringify(decision) },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).labels).toEqual([label, 'archon-small', 'area', 'nonexistent'].sort());
  }
});

test('malformed qualified triage identity refuses before invoking a transport', () => {
  for (const item of [
    { repo: { host: '', path: 'repo' }, number: 1 },
    { repo: PR.repo, number: 0 },
    { repo: PR.repo, number: 1.5 },
  ]) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'forge',
      inputs: { ...inputs, INPUTS_ITEM: JSON.stringify(item) },
    });
    expect(run.code).not.toBe(0);
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  }
});

test('forge publication fails without label facts rather than assuming no labels', () => {
  const run = runPackScript('triage/scripts/verdict', {
    source: 'forge',
    inputs,
    forge: {
      kind: 'fake',
      response: forgeOperation('workitem.view', {
        ref: { repo: PR.repo, number: 7 },
        kind: 'issue',
      }),
    },
  });
  expect(run.code).not.toBe(0);
  expect(run.gh).toEqual([]);
  expect(run.forge).toHaveLength(1);
  expect(run.stderr).toContain('label facts');
});

test('forge failures preserve unknown outcome evidence and never fall back or retry', () => {
  const run = runPackScript('triage/scripts/verdict', {
    source: 'forge',
    inputs,
    forge: { kind: 'fake', response: forgeFailure('workitem.view', 'outcome_unknown', 'response lost') },
  });
  expect(run.code).not.toBe(0);
  expect(run.gh).toEqual([]);
  expect(run.forge).toHaveLength(1);
  expect(run.stderr).toContain('outcome_unknown');
  expect(run.stdout).toBe('');
});

test('default triage preserves inherited-property labels and accepts them as area labels', () => {
  const operatorLabels = Object.getOwnPropertyNames(Object.prototype);
  for (const area of [[], ['constructor']]) {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: { ...inputs, INPUTS_AREA_LABELS: JSON.stringify(area) },
      gh: {
        issueLabels: ['archon-blocked', ...operatorLabels],
        repositoryLabels: ['archon-blocked', ...operatorLabels],
      },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout).published).toBe(true);
    const edit = run.gh.find(call => call.startsWith('issue edit'));
    expect(edit).toContain('--remove-label archon-blocked');
    for (const name of operatorLabels) expect(edit).not.toContain(`--remove-label ${name}`);
  }
});

test('a gh label write is one delta that leaves labels it does not name on the item', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_AREA_LABELS: '[]' },
    gh: {
      issueLabels: ['operator', 'archon-blocked', 'archon-small'],
      repositoryLabels: ['operator', 'archon-blocked', 'archon-small', 'archon-ready'],
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  // A delta, not a whole-set write: a label another writer adds before this edit
  // lands is never named, so it survives.
  expect(run.gh.filter(call => call.startsWith('issue edit'))).toEqual([
    'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-ready --remove-label archon-blocked',
  ]);
  expect(run.gh.filter(call => call.includes('/issues/7')).length).toBe(2);
  expect(JSON.parse(run.stdout).labels).toEqual(['archon-ready', 'archon-small']);
});
