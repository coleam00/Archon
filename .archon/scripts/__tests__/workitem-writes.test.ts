import { expect, test } from 'bun:test';
import type { Closure } from '../../workflows/sdlc/.shared/close';
import {
  forgeFailure,
  forgeOperation,
  PR,
  packScriptRunner,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const TRIAGE = {
  decision: { contract: 'READY', route: 'deliver' } as Record<string, unknown>,
  type: { value: 'feature', reason: 'new behavior' },
  size: { value: 's', reason: 'one script' },
  complexity: { value: 'low', reason: 'clear change' },
  importance: { value: 'medium', reason: 'on direction' },
  urgency: { value: 'none', reason: 'nothing waits on it' },
  item: { repo: PR.repo, number: 7 } as Record<string, unknown>,
  area_labels: ['area', 'nonexistent'],
  related: [],
  summary: 'Ready',
  report: { path: 'triage.md' },
};

/** The labels node's inputs: the triage node's typed output, patched, under publish. */
function labelInputs(patch: Partial<typeof TRIAGE> = {}, publish = 'true'): Record<string, string> {
  return { INPUTS_TRIAGE: JSON.stringify({ ...TRIAGE, ...patch }), INPUTS_PUBLISH: publish };
}
const inputs = labelInputs();

test('unpublished and non-tracker triage never invoke either transport', () => {
  for (const unpublished of [
    labelInputs({}, 'false'),
    labelInputs({ item: { repo: { host: '', path: '' }, number: 0 } }),
  ]) {
    const run = runPackScript('triage/scripts/labels', { inputs: unpublished });
    expect(run.code).toBe(0);
    expect(run.forge).toEqual([]);
    expect(JSON.parse(run.stdout).published).toBe(false);
  }
});

const DELIVERED: Closure = { kind: 'delivered', url: 'https://ghe.example.com/example/repo/pull/5' };

test('a published close verdict labels the item and closes nothing; intake owns the close', () => {
  const run = runPackScript('triage/scripts/labels', {
    inputs: labelInputs({ decision: { contract: 'NO_ACTION', closure: DELIVERED } }),
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(run.stdout).published).toBe(true);
  expect([...run.closes, ...run.comments]).toEqual([]);
});

test('forge publication fails without label facts rather than assuming no labels', () => {
  const run = runPackScript('triage/scripts/labels', {
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
  const run = runPackScript('triage/scripts/labels', {
    inputs,
    forge: { kind: 'fake', response: forgeFailure('workitem.view', 'outcome_unknown', 'response lost') },
  });
  expect(run.code).not.toBe(0);
  expect(run.forge).toHaveLength(1);
  expect(run.stderr).toContain('outcome_unknown');
  expect(run.stdout).toBe('');
});

test('a triage that could not read the forge is refused before any label is read or written', () => {
  const run = runPackScript('triage/scripts/labels', {
    inputs: labelInputs({ decision: { contract: 'NOT_TRIAGED', failed: [{ op: 'workitem.search', kind: 'forge_error' }] } }),
  });
  expect(run.code).not.toBe(0);
  expect(run.stdout).toBe('');
  expect(run.forge).toEqual([]);
  expect(run.stderr).toContain('workitem.search (forge_error)');
});

test('a pack label is never accepted as an area label', () => {
  const run = runPackScript('triage/scripts/labels', {
    inputs: labelInputs({ area_labels: ['archon-ready'] }),
  });
  expect(run.code).not.toBe(0);
  expect(run.forge).toEqual([]);
  expect(run.stderr).toContain('may not name a pack label');
});

test('forge triage adds the labels it lacks and removes only the stale one it owns', () => {
  const item = { ref: { repo: PR.repo, number: 7 }, kind: 'issue', url: 'https://ghe.example.com/example/repo/issues/7', state: 'open' };
  const applied = (op: string) => forgeOperation(op, { outcome: 'applied' });
  const run = runPackScript('triage/scripts/labels', {
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
