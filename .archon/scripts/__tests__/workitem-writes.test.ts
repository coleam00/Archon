import { expect, test } from 'bun:test';
import { forgeFailure, forgeOperation, PR, runPackScript } from './pack-script-harness';
const inputs = {
  INPUTS_ITEM: JSON.stringify({ repo: PR.repo, number: 7 }),
  INPUTS_PUBLISH: 'true',
  INPUTS_CONTRACT: 'READY',
  INPUTS_ROUTE: 'deliver',
  INPUTS_COMPLEXITY: 'small',
  INPUTS_DESIGN_FIRST: 'false',
  INPUTS_SUMMARY: 'Ready',
  INPUTS_BLOCKED_REASON: '',
  INPUTS_BLOCKED_BY: '[]',
  INPUTS_AREA_LABELS: '["area","nonexistent"]',
  INPUTS_PROPOSED_EDITS: '{"title":"","body":""}',
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
    forge: {
      kind: 'fake',
      response: forgeFailure('workitem.view', 'outcome_unknown', 'response lost'),
    },
  });
  expect(run.code).not.toBe(0);
  expect(run.gh).toEqual([]);
  expect(run.forge).toHaveLength(1);
  expect(run.stderr).toContain('outcome_unknown');
  expect(run.stdout).toBe('');
});

// Ship routes on the state label, so each READY route carries its own.
test('a READY item is labelled with the route ship takes on it', () => {
  for (const [route, designFirst, label] of [
    ['deliver', 'false', 'archon-ready'],
    ['plan', 'false', 'archon-plan'],
    ['plan', 'true', 'archon-need-design'],
    ['investigate', 'false', 'archon-issue'],
  ]) {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_ROUTE: route, INPUTS_DESIGN_FIRST: designFirst },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout).labels).toContain(label);
  }
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
