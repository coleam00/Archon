import { expect, test } from 'bun:test';
import type { Closure } from '../../workflows/sdlc/.shared/close';
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
  INPUTS_TYPE: '{"value":"feature","reason":"new behavior"}',
  INPUTS_SIZE: '{"value":"s","reason":"one script"}',
  INPUTS_COMPLEXITY: '{"value":"low","reason":"clear change"}',
  INPUTS_IMPORTANCE: '{"value":"medium","reason":"on direction"}',
  INPUTS_URGENCY: '{"value":"none","reason":"nothing waits on it"}',
  INPUTS_SUMMARY: 'Ready',
  INPUTS_AREA_LABELS: '["area","nonexistent"]',
  INPUTS_RELATED: '[]',
  INPUTS_REPORT: '{"path":"triage.md"}',
};

test('unpublished and non-tracker triage never invoke either transport', () => {
  for (const patch of [
    { INPUTS_PUBLISH: 'false' },
    { INPUTS_ITEM: '{"repo":{"host":"","path":""},"number":0}' },
  ]) {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: { ...inputs, ...patch },
    });
    expect(run.code).toBe(0);
    expect(run.forge).toEqual([]);
    expect(JSON.parse(run.stdout).published).toBe(false);
  }
});

test('a ready item is labelled with the route the run takes on it', () => {
  for (const [decision, label] of [
    [{ contract: 'READY', route: 'plan' }, 'archon-plan'],
    [{ contract: 'READY', route: 'investigate' }, 'archon-investigate'],
    [{ contract: 'READY', route: 'continue', pull_request: 3 }, 'archon-ready'],
    [{ contract: 'READY', route: 'split' }, 'archon-split'],
  ] as const) {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_DECISION: JSON.stringify(decision) },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).labels).toEqual(
      [label, 'archon-size-s', 'archon-type-feature', 'area', 'nonexistent'].sort()
    );
  }
});

const DELIVERED: Closure = { kind: 'delivered', url: 'https://ghe.example.com/example/repo/pull/5' };

test('a close verdict keeps the type label, drops the size label, and carries its closure', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_PUBLISH: 'false',
      INPUTS_DECISION: JSON.stringify({ contract: 'NO_ACTION', closure: DELIVERED }),
      INPUTS_REPORT: '{"type":"archon_artifact","run_id":"r","path":"triage.md"}',
    },
  });
  expect(run.code).toBe(0);
  const output = JSON.parse(run.stdout);
  expect(output.labels).toEqual(['archon-close', 'archon-type-feature', 'area', 'nonexistent']);
  expect(output.closure).toEqual(DELIVERED);
});

test('a published close verdict labels the item and closes nothing; intake owns the close', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_DECISION: JSON.stringify({ contract: 'NO_ACTION', closure: DELIVERED }),
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(run.stdout).published).toBe(true);
  expect([...run.closes, ...run.comments]).toEqual([]);
});

test('forge publication fails without label facts rather than assuming no labels', () => {
  const run = runPackScript('triage/scripts/verdict', {
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
  expect(run.forge).toHaveLength(1);
  expect(run.stderr).toContain('label facts');
});

test('forge failures preserve unknown outcome evidence and never fall back or retry', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs,
    forge: { kind: 'fake', response: forgeFailure('workitem.view', 'outcome_unknown', 'response lost') },
  });
  expect(run.code).not.toBe(0);
  expect(run.forge).toHaveLength(1);
  expect(run.stderr).toContain('outcome_unknown');
  expect(run.stdout).toBe('');
});

test('re-triage replaces a changed type and removes a retired size label', () => {
  const item = { ref: { repo: PR.repo, number: 7 }, kind: 'issue', url: 'https://ghe.example.com/example/repo/issues/7', state: 'open' };
  const labels = ['operator', 'archon-ready', 'archon-risky', 'archon-type-bug'];
  const applied = (op: string) => forgeOperation(op, { outcome: 'applied' });
  const run = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_AREA_LABELS: '[]' },
    forge: {
      kind: 'fake',
      response: [
        forgeOperation('workitem.view', { ...item, title: 't', body: 'b', labels }),
        forgeOperation('repo.labels.list', { repo: PR.repo, labels: labels.map(name => ({ name })) }),
        applied('repo.label.ensure'),
        applied('repo.label.ensure'),
        ...Array.from({ length: 2 }, () => applied('workitem.label.add')),
        ...Array.from({ length: 2 }, () => applied('workitem.label.remove')),
      ],
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  const writes = run.forge
    .map((argv, index) => [argv.split(' ')[1], JSON.parse(run.forgeRequests[index] ?? '{}').name])
    .filter(([op]) => op !== 'workitem.view' && op !== 'repo.labels.list');
  expect(writes).toEqual([
    ['repo.label.ensure', 'archon-type-feature'],
    ['repo.label.ensure', 'archon-size-s'],
    ['workitem.label.add', 'archon-size-s'],
    ['workitem.label.add', 'archon-type-feature'],
    ['workitem.label.remove', 'archon-type-bug'],
    ['workitem.label.remove', 'archon-risky'],
  ]);
  expect(JSON.parse(run.stdout).labels).toEqual(['archon-ready', 'archon-size-s', 'archon-type-feature']);
});

test('a retired size label is never created and never accepted as an area label', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_AREA_LABELS: '["archon-small"]' },
  });
  expect(run.code).not.toBe(0);
  expect(run.forge).toEqual([]);
  expect(run.stderr).toContain('may not name a pack label');
});

test('forge triage adds the labels it lacks and removes only the stale one it owns', () => {
  const item = { ref: { repo: PR.repo, number: 7 }, kind: 'issue', url: 'https://ghe.example.com/example/repo/issues/7', state: 'open' };
  const applied = (op: string) => forgeOperation(op, { outcome: 'applied' });
  const run = runPackScript('triage/scripts/verdict', {
    inputs,
    forge: {
      kind: 'fake',
      response: [
        forgeOperation('workitem.view', { ...item, title: 't', body: 'b', labels: ['archon-plan', 'someone-elses'] }),
        forgeOperation('repo.labels.list', {
          repo: PR.repo,
          labels: ['archon-ready', 'archon-plan', 'archon-size-s', 'archon-type-feature', 'area'].map(name => ({ name })),
        }),
        ...Array.from({ length: 4 }, () => applied('workitem.label.add')),
        applied('workitem.label.remove'),
      ],
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  const writes = run.forge
    .map((argv, index) => [argv.split(' ')[1], JSON.parse(run.forgeRequests[index] ?? '{}').name])
    .filter(([op]) => op?.startsWith('workitem.label.'));
  expect(writes).toEqual([
    ['workitem.label.add', 'archon-ready'],
    ['workitem.label.add', 'archon-size-s'],
    ['workitem.label.add', 'archon-type-feature'],
    ['workitem.label.add', 'area'],
    ['workitem.label.remove', 'archon-plan'],
  ]);
});
