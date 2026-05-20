import { describe, it, expect } from 'bun:test';
import { runStructuralRules } from '../../validation/rules/structural';
import type { DagNode } from '../../schemas';

// ---------------------------------------------------------------------------
// Helpers — build minimal DagNode values that bypass Zod (for testing rules
// against structurally invalid data that wouldn't pass schema validation).
// All casts go through `unknown` to satisfy TypeScript.
// ---------------------------------------------------------------------------

const promptNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id: 'a', prompt: 'hello', ...over }) as unknown as DagNode;

const commandNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id: 'c', command: 'my-cmd', ...over }) as unknown as DagNode;

const bashNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id: 'b', bash: 'echo hi', ...over }) as unknown as DagNode;

const scriptNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id: 's', script: 'console.log(1)', runtime: 'bun', ...over }) as unknown as DagNode;

const loopNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({
    id: 'l',
    loop: { prompt: 'think', until: 'DONE', max_iterations: 3 },
    ...over,
  }) as unknown as DagNode;

const approvalNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id: 'ap', approval: { message: 'Approve?' }, ...over }) as unknown as DagNode;

const cancelNode = (over: Partial<Record<string, unknown>> = {}): DagNode =>
  ({ id: 'ca', cancel: 'workflow failed', ...over }) as unknown as DagNode;

// ---------------------------------------------------------------------------

describe('structural rules', () => {
  it('returns no issues for a valid prompt node', () => {
    expect(runStructuralRules([promptNode()])).toEqual([]);
  });

  it('returns no issues for a valid command node', () => {
    expect(runStructuralRules([commandNode()])).toEqual([]);
  });

  it('returns no issues for a valid bash node', () => {
    expect(runStructuralRules([bashNode()])).toEqual([]);
  });

  it('returns no issues for a valid script node', () => {
    expect(runStructuralRules([scriptNode()])).toEqual([]);
  });

  it('returns no issues for a valid loop node', () => {
    expect(runStructuralRules([loopNode()])).toEqual([]);
  });

  it('returns no issues for a valid approval node', () => {
    expect(runStructuralRules([approvalNode()])).toEqual([]);
  });

  it('returns no issues for a valid cancel node', () => {
    expect(runStructuralRules([cancelNode()])).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // id rules
  // -------------------------------------------------------------------------

  it('flags empty ids', () => {
    const issues = runStructuralRules([promptNode({ id: '' })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      rule: 'structural.id.empty',
      severity: 'error',
      source: 'client-instant',
      path: { nodeId: '' },
    });
  });

  it('flags whitespace-only ids', () => {
    const issues = runStructuralRules([promptNode({ id: '   ' })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('structural.id.empty');
  });

  it('flags duplicate ids on every node that shares the id', () => {
    const issues = runStructuralRules([promptNode({ id: 'dup' }), commandNode({ id: 'dup' })]);
    const dupeIssues = issues.filter(i => i.rule === 'structural.id.duplicate');
    expect(dupeIssues).toHaveLength(2);
  });

  it('does not flag unique ids as duplicate', () => {
    const issues = runStructuralRules([promptNode({ id: 'x' }), commandNode({ id: 'y' })]);
    expect(issues.filter(i => i.rule === 'structural.id.duplicate')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // required field rules per variant
  // -------------------------------------------------------------------------

  it('flags missing command field on command node (empty string)', () => {
    const bad = commandNode({ command: '' });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.command')).toBe(true);
  });

  it('flags missing prompt field on prompt node (empty string)', () => {
    const bad = promptNode({ prompt: '' });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.prompt')).toBe(true);
  });

  it('flags missing bash field on bash node (empty string)', () => {
    const bad = bashNode({ bash: '' });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.bash')).toBe(true);
  });

  it('flags missing script field on script node (empty string)', () => {
    const bad = scriptNode({ script: '' });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.script')).toBe(true);
  });

  it('flags missing loop config on loop node (undefined)', () => {
    const bad = loopNode({ loop: undefined });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.loop')).toBe(true);
  });

  it('flags missing loop.prompt on loop node', () => {
    const bad = loopNode({ loop: { prompt: '', until: 'DONE', max_iterations: 3 } });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.loop.prompt')).toBe(true);
  });

  it('flags missing loop.until on loop node', () => {
    const bad = loopNode({ loop: { prompt: 'think', until: '', max_iterations: 3 } });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.loop.until')).toBe(true);
  });

  it('flags missing loop.max_iterations on loop node', () => {
    const bad = loopNode({ loop: { prompt: 'think', until: 'DONE', max_iterations: 0 } });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.loop.max_iterations')).toBe(true);
  });

  it('flags missing approval object on approval node (undefined)', () => {
    const bad = approvalNode({ approval: undefined });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.approval')).toBe(true);
    // And NOT the sub-field rule — those are distinct failure modes.
    expect(issues.some(i => i.rule === 'structural.required.approval.message')).toBe(false);
  });

  it('flags missing approval.message on approval node (empty string)', () => {
    const bad = approvalNode({ approval: { message: '' } });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.approval.message')).toBe(true);
    // And NOT the missing-object rule — those are distinct failure modes.
    expect(issues.some(i => i.rule === 'structural.required.approval')).toBe(false);
  });

  it('flags missing cancel reason (empty string)', () => {
    const bad = cancelNode({ cancel: '' });
    const issues = runStructuralRules([bad]);
    expect(issues.some(i => i.rule === 'structural.required.cancel')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // issue stability
  // -------------------------------------------------------------------------

  it('issue ids are stable across runs', () => {
    const a = runStructuralRules([promptNode({ id: '' })]);
    const b = runStructuralRules([promptNode({ id: '' })]);
    expect(a[0].id).toBe(b[0].id);
  });

  it('issue ids are unique for different rules on the same node', () => {
    // A loop node missing all required sub-fields
    const bad = loopNode({
      loop: { prompt: '', until: '', max_iterations: 0 },
    });
    const issues = runStructuralRules([bad]);
    const ids = issues.map(i => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
