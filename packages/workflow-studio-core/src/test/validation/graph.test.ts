import { describe, it, expect } from 'bun:test';
import { runGraphRules } from '../../validation/rules/graph';
import type { DagNode } from '../../schemas';

// ---------------------------------------------------------------------------
// Helper — builds a minimal flat PromptNode shape cast through `unknown`.
// The real DagNode is a flat discriminated union (no `type` field, no `base`
// wrapper). We use `as unknown as DagNode` to bypass Zod for unit testing.
// See drift note 6.1.1 for context.
// ---------------------------------------------------------------------------
const n = (id: string, depends_on: string[] = [], over: Record<string, unknown> = {}): DagNode =>
  ({ id, prompt: 'x', depends_on, ...over }) as unknown as DagNode;

// ---------------------------------------------------------------------------
// NOTE (drift 6.2.1): The plan included a "flags unknown decision branch
// targets" test. That test has been dropped because the `decision` variant
// does not exist in the current DagNode schema — there are no routing edges
// (on_success/on_failure/goto) at the schema level. See phase-6-drift-notes.md
// entry 6.2.1 for the full rationale.
// ---------------------------------------------------------------------------

describe('graph rules', () => {
  it('passes a linear DAG', () => {
    expect(runGraphRules([n('a'), n('b', ['a']), n('c', ['b'])])).toEqual([]);
  });

  it('flags a self-cycle', () => {
    const issues = runGraphRules([n('a', ['a'])]);
    const cyc = issues.filter(i => i.rule === 'graph.cycle');
    expect(cyc).toHaveLength(1);
    expect(cyc[0].path.nodeId).toBe('a');
    // Self-ref is not an unknown ref — 'a' exists in the graph.
    expect(issues.filter(i => i.rule === 'graph.ref.unknown')).toHaveLength(0);
  });

  it('flags two disconnected cycles independently', () => {
    const issues = runGraphRules([n('a', ['a']), n('b', ['b'])]);
    const cyc = issues.filter(i => i.rule === 'graph.cycle');
    expect(cyc).toHaveLength(2);
    expect(new Set(cyc.map(i => i.path.nodeId))).toEqual(new Set(['a', 'b']));
  });

  it('emits both ref.unknown and cycle when a node has both', () => {
    // 'a' depends on itself (cycle) and on a non-existent 'ghost' (ref).
    const issues = runGraphRules([n('a', ['a', 'ghost'])]);
    expect(issues.filter(i => i.rule === 'graph.cycle')).toHaveLength(1);
    const refs = issues.filter(i => i.rule === 'graph.ref.unknown');
    expect(refs).toHaveLength(1);
    expect(refs[0].message).toContain('ghost');
  });

  it('flags a 3-node cycle and attaches an issue to every member', () => {
    const issues = runGraphRules([n('a', ['c']), n('b', ['a']), n('c', ['b'])]);
    const cyc = issues.filter(i => i.rule === 'graph.cycle');
    expect(cyc.length).toBe(3);
    expect(new Set(cyc.map(i => i.path.nodeId))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('flags unknown depends_on references', () => {
    const issues = runGraphRules([n('a', ['ghost'])]);
    const refs = issues.filter(i => i.rule === 'graph.ref.unknown');
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toMatchObject({ nodeId: 'a', field: 'depends_on' });
    expect(refs[0].message).toContain('ghost');
  });

  it('issue ids are stable across runs', () => {
    const a = runGraphRules([n('a', ['ghost'])]);
    const b = runGraphRules([n('a', ['ghost'])]);
    expect(a[0].id).toBe(b[0].id);
  });
});
