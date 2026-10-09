import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  forgeFailure,
  forgeOperation,
  forgePrRecord,
  PR,
  runPackScript,
} from './deliver-checks-harness';
const inputs = {
  INPUTS_ITEM: JSON.stringify({ repo: PR.repo, number: 7 }),
  INPUTS_PUBLISH: 'true',
  INPUTS_DECISION: JSON.stringify({ contract: 'READY', route: 'deliver', design_first: false }),
  INPUTS_COMPLEXITY: 'small',
  INPUTS_SUMMARY: 'Ready',
  INPUTS_AREA_LABELS: '["area","nonexistent"]',
  INPUTS_REPORT: '{"path":"triage.md"}',
};
const record = {
  title: 'Discovery',
  claim: 'Claim',
  evidence: ['file:3'],
  relation: 'unrelated',
  source_nodes: ['review'],
};
const discoveries = {
  INPUTS_PR: JSON.stringify(forgePrRecord()),
  INPUTS_INITIAL: JSON.stringify([record]),
  INPUTS_FINAL: 'null',
  INPUTS_MATCHES: '[]',
};
/** file-discoveries' resume ledger: issue URL by repository, title and claim. */
const ledgerKey = createHash('sha256')
  .update(`${PR.repo.host}/${PR.repo.path}\n${record.title}\n${record.claim}`)
  .digest('hex');
const ledger = (artifacts: string): Record<string, string> =>
  JSON.parse(readFileSync(join(artifacts, 'discoveries-filed.json'), 'utf8')) as Record<string, string>;

test('default gh triage applies wanted labels and default discovery persists read-back URL', () => {
  const triage = runPackScript('triage/scripts/verdict', { inputs });
  expect({ code: triage.code, stderr: triage.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(triage.stdout)).toMatchObject({
    published: true,
    labels: ['archon-ready', 'archon-small', 'area'],
  });
  expect(triage.forge).toEqual([]);
  expect(triage.gh.some(call => call.includes('--hostname ghe.example.com'))).toBe(true);
  expect(triage.gh.some(call => call.startsWith('label create nonexistent'))).toBe(false);
  const discovery = runPackScript('deliver/scripts/file-discoveries', { inputs: discoveries });
  expect({ code: discovery.code, stderr: discovery.stderr }).toMatchObject({ code: 0 });
  expect(discovery.gh).toHaveLength(2);
  expect(discovery.forge).toEqual([]);
  expect(ledger(discovery.artifacts)[ledgerKey]).toBe(JSON.parse(discovery.stdout).records[0].issue);
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
  for (const script of ['triage/scripts/verdict', 'deliver/scripts/file-discoveries']) {
    const op = script.includes('triage') ? 'workitem.view' : 'workitem.create';
    const run = runPackScript(script, {
      source: 'forge',
      inputs: { ...inputs, ...discoveries },
      forge: { kind: 'fake', response: forgeFailure(op, 'outcome_unknown', 'response lost') },
    });
    expect(run.code).not.toBe(0);
    expect(run.gh).toEqual([]);
    expect(run.forge).toHaveLength(1);
    expect(run.stderr).toContain('outcome_unknown');
    expect(run.stdout).toBe('');
  }
});

test('ledgered records resume without a write and invalid source cannot fall back', () => {
  const resumed = runPackScript('deliver/scripts/file-discoveries', {
    source: 'forge',
    inputs: discoveries,
    artifacts: {
      'discoveries-filed.json': JSON.stringify({ [ledgerKey]: 'https://tracker.example/items/1' }),
    },
  });
  expect(resumed.code).toBe(0);
  expect(resumed.gh).toEqual([]);
  expect(resumed.forge).toEqual([]);
  const invalid = runPackScript('deliver/scripts/file-discoveries', {
    source: 'invalid',
    inputs: discoveries,
  });
  expect(invalid.code).not.toBe(0);
  expect(invalid.gh).toEqual([]);
  expect(invalid.forge).toEqual([]);
});

test('default gh discovery retains URL even when read-back disagrees', () => {
  const run = runPackScript('deliver/scripts/file-discoveries', {
    gh: { writeLost: true },
    inputs: discoveries,
  });
  expect(run.code).not.toBe(0);
  expect(ledger(run.artifacts)[ledgerKey]).toContain('/issues/');
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
