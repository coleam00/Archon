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
test('gh triage applies wanted labels', () => {
  const triage = runPackScript('triage/scripts/verdict', { source: 'gh', inputs });
  expect({ code: triage.code, stderr: triage.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(triage.stdout)).toMatchObject({
    published: true,
    labels: ['archon-ready', 'archon-size-s', 'archon-type-feature', 'area'],
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
    [{ contract: 'READY', route: 'investigate' }, 'archon-investigate'],
    [{ contract: 'READY', route: 'continue', pull_request: 3 }, 'archon-ready'],
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

test('the verdict passes all five triage fields through unchanged', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_PUBLISH: 'false',
      INPUTS_COMPLEXITY: '{"value":"high","reason":"unknown design"}',
      INPUTS_IMPORTANCE: '{"value":"low","reason":"off direction"}',
      INPUTS_URGENCY: '{"value":"soon","reason":"release next week"}',
    },
  });
  expect(run.code).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({
    type: { value: 'feature', reason: 'new behavior' },
    size: { value: 's', reason: 'one script' },
    complexity: { value: 'high', reason: 'unknown design' },
    importance: { value: 'low', reason: 'off direction' },
    urgency: { value: 'soon', reason: 'release next week' },
  });
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
    source: 'gh',
    inputs: {
      ...inputs,
      INPUTS_DECISION: JSON.stringify({ contract: 'NO_ACTION', closure: DELIVERED }),
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(run.stdout).published).toBe(true);
  expect([...run.closes, ...run.comments]).toEqual([]);
});

test("a close link that is not a qualified URL is refused, so a guess never reaches intake", () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_PUBLISH: 'false',
      INPUTS_DECISION: JSON.stringify({
        contract: 'NO_ACTION',
        closure: { kind: 'delivered', url: 'pull 5' },
      }),
    },
  });
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain('closure.url must be a fully qualified');
});

test('related work reaches the verdict as declared, and a related link that is not a qualified URL is refused', () => {
  const related = [{ url: 'https://ghe.example.com/example/repo/pull/5', relation: 'merged change on the same surface' }];
  const passed = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_RELATED: JSON.stringify(related) },
  });
  expect({ code: passed.code, stderr: passed.stderr }).toEqual({ code: 0, stderr: '' });
  expect((JSON.parse(passed.stdout) as { related: unknown }).related).toEqual(related);

  const refused = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_RELATED: '[{"url":"issue 5","relation":"overlaps"}]' },
  });
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('related urls must be fully qualified');
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

test('gh triage preserves inherited-property labels and accepts them as area labels', () => {
  const operatorLabels = Object.getOwnPropertyNames(Object.prototype);
  for (const area of [[], ['constructor']]) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'gh',
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
    source: 'gh',
    inputs: { ...inputs, INPUTS_AREA_LABELS: '[]' },
    gh: {
      issueLabels: ['operator', 'archon-blocked', 'archon-size-s', 'archon-type-feature'],
      repositoryLabels: [
        'operator',
        'archon-blocked',
        'archon-size-s',
        'archon-type-feature',
        'archon-ready',
      ],
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  // A delta, not a whole-set write: a label another writer adds before this edit
  // lands is never named, so it survives.
  expect(run.gh.filter(call => call.startsWith('issue edit'))).toEqual([
    'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-ready --remove-label archon-blocked',
  ]);
  expect(run.gh.filter(call => call.includes('/issues/7')).length).toBe(2);
  expect(JSON.parse(run.stdout).labels).toEqual([
    'archon-ready',
    'archon-size-s',
    'archon-type-feature',
  ]);
});

test('re-triage replaces a changed type and removes a retired size label', () => {
  const run = runPackScript('triage/scripts/verdict', {
    source: 'gh',
    inputs: { ...inputs, INPUTS_AREA_LABELS: '[]' },
    gh: {
      issueLabels: ['operator', 'archon-ready', 'archon-risky', 'archon-type-bug'],
      repositoryLabels: ['operator', 'archon-ready', 'archon-risky', 'archon-type-bug'],
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  expect(run.gh.filter(call => call.startsWith('label create'))).toEqual([
    expect.stringContaining('label create archon-type-feature'),
    expect.stringContaining('label create archon-size-s'),
  ]);
  expect(run.gh.filter(call => call.startsWith('issue edit'))).toEqual([
    'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-size-s --add-label archon-type-feature --remove-label archon-risky --remove-label archon-type-bug',
  ]);
  expect(JSON.parse(run.stdout).labels).toEqual([
    'archon-ready',
    'archon-size-s',
    'archon-type-feature',
  ]);
});

test('a retired size label is never created and never accepted as an area label', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_AREA_LABELS: '["archon-small"]' },
  });
  expect(run.code).not.toBe(0);
  expect(run.gh).toEqual([]);
  expect(run.stderr).toContain('may not name a pack label');
});

test('forge triage adds the labels it lacks and removes only the stale one it owns', () => {
  const item = { ref: { repo: PR.repo, number: 7 }, kind: 'issue', url: 'https://ghe.example.com/example/repo/issues/7', state: 'open' };
  const applied = (op: string) => forgeOperation(op, { outcome: 'applied' });
  const run = runPackScript('triage/scripts/verdict', {
    source: 'forge',
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
