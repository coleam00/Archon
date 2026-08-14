import { describe, test, expect } from 'bun:test';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition } from '../model';
import type { BuilderWorkflow } from '../types';
import { computeProposalPreview } from './preview-diff';
import type { ProposedEdit } from './op-schema';

function workflow(): BuilderWorkflow {
  return fromWorkflowDefinition(FIXTURES.mixed).workflow;
}

describe('computeProposalPreview', () => {
  test('an added node ghosts as "add" and keeps all current nodes intact', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
    ]);
    expect(preview.issues).toHaveLength(0);
    expect(preview.ghosts.get('gate')).toBe('add');
    const ids = preview.workflow.nodes.map(n => n.id);
    expect(ids).toContain('classify');
    expect(ids).toContain('fix');
    expect(ids).toContain('report');
    expect(ids).toContain('gate');
    expect(preview.positions.has('gate')).toBe(true);
  });

  test('a removed node ghosts as "remove" and is RE-INCLUDED in the union workflow', () => {
    const preview = computeProposalPreview(workflow(), [{ op: 'remove', id: 'fix' }]);
    expect(preview.ghosts.get('fix')).toBe('remove');
    expect(preview.workflow.nodes.map(n => n.id)).toContain('fix');
  });

  test('a changed node (setField) ghosts as "changed"', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'setField', id: 'classify', path: 'data.prompt', value: 'Different prompt.' },
    ]);
    expect(preview.ghosts.get('classify')).toBe('changed');
    // Nodes untouched by the batch are not ghosted at all.
    expect(preview.ghosts.has('report')).toBe(false);
  });

  test('an unresolvable op contributes an issue but the rest of the batch still previews', () => {
    const ops: ProposedEdit[] = [
      { op: 'addNode', id: 'gate', variant: 'approval' },
      { op: 'connect', source: 'nope', target: 'gate' },
    ];
    const preview = computeProposalPreview(workflow(), ops);
    expect(preview.issues.some(i => i.rule === 'copilot.connect.unknownSource')).toBe(true);
    expect(preview.ghosts.get('gate')).toBe('add');
  });

  test('a batch that would introduce a would-be validation problem surfaces it via runValidation', () => {
    // Renaming to an id containing an invalid character trips validateStructural,
    // but the translator itself only blocks on collision — this proves would-be
    // structural/content issues from runValidation ride through, not just op issues.
    const preview = computeProposalPreview(workflow(), [
      { op: 'setField', id: 'fix', path: 'base.depends_on', value: ['does-not-exist'] },
    ]);
    expect(preview.issues.length).toBeGreaterThan(0);
  });

  test('an empty ops array is a no-op preview with no ghosts and no issues', () => {
    const preview = computeProposalPreview(workflow(), []);
    expect(preview.ghosts.size).toBe(0);
    expect(preview.issues).toHaveLength(0);
    expect(preview.workflow.nodes.map(n => n.id).sort()).toEqual(['classify', 'fix', 'report']);
  });
});

/**
 * These fold through `editorReducer`, which is the only place the original
 * `setField` corruption became visible: `patch-node` REPLACES a node rather than
 * merging it, so a second patch built from the stale pre-batch node silently
 * reverted the first. Asserting on the translated actions alone is a weaker
 * guard than asserting on the folded result.
 */
describe('computeProposalPreview — batch-local setField composition', () => {
  test('two setFields on the same node both survive the fold', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'setField', id: 'classify', path: 'base.output_type', value: 'FIRST' },
      { op: 'setField', id: 'classify', path: 'base.trigger_rule', value: 'all_done' },
    ] as ProposedEdit[]);
    expect(preview.issues).toHaveLength(0);
    const node = preview.workflow.nodes.find(n => n.id === 'classify');
    expect(node?.base.output_type).toBe('FIRST');
    expect(node?.base.trigger_rule).toBe('all_done');
  });

  test('last write wins when the same field is set twice', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'setField', id: 'classify', path: 'base.output_type', value: 'first' },
      { op: 'setField', id: 'classify', path: 'base.output_type', value: 'second' },
    ] as ProposedEdit[]);
    expect(preview.issues).toHaveLength(0);
    expect(preview.workflow.nodes.find(n => n.id === 'classify')?.base.output_type).toBe('second');
  });

  test('rename then setField on the new id lands on the renamed node', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'rename', id: 'classify', nextId: 'triage' },
      { op: 'setField', id: 'triage', path: 'base.output_type', value: 'after rename' },
    ] as ProposedEdit[]);
    expect(preview.issues.filter(i => i.severity === 'error')).toHaveLength(0);
    const node = preview.workflow.nodes.find(n => n.id === 'triage');
    expect(node?.base.output_type).toBe('after rename');
  });

  test('a proposed connection ghosts as an added edge', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
      { op: 'connect', source: 'classify', target: 'gate' },
    ] as ProposedEdit[]);
    const added = [...preview.edgeGhosts.entries()].filter(([, k]) => k === 'add');
    expect(added.length).toBeGreaterThan(0);
  });

  test('removing a node ghosts the edges that disappear with it', () => {
    const before = computeProposalPreview(workflow(), [
      { op: 'remove', id: 'classify' },
    ] as ProposedEdit[]);
    const removed = [...before.edgeGhosts.entries()].filter(([, k]) => k === 'remove');
    expect(removed.length).toBeGreaterThan(0);
  });
});
