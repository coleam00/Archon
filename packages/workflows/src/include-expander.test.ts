import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes, INCLUDE_MAX_DEPTH } from './include-expander';
import { dagNodeSchema } from './schemas';
import type { WorkflowDefinition, DagNode } from './schemas';

// ---------------------------------------------------------------------------
// Helpers — build WorkflowDefinitions in-memory (pure: no parseWorkflow, no
// logger, no module mocking → this file safely shares a bun-test batch).
// ---------------------------------------------------------------------------

function wf(name: string, nodes: unknown[]): WorkflowDefinition {
  return {
    name,
    description: `${name} description`,
    nodes: nodes.map(n => dagNodeSchema.parse(n)),
  };
}

function mapOf(...workflows: WorkflowDefinition[]): Map<string, WorkflowDefinition> {
  return new Map(workflows.map(w => [w.name, w]));
}

function nodeById(w: WorkflowDefinition, id: string): DagNode | undefined {
  return w.nodes.find(n => n.id === id);
}

/** A 3-node review-like block: verify -> scope -> impl (sole sink = impl). */
function blockWorkflow(): WorkflowDefinition {
  return wf('blk', [
    { id: 'verify', bash: 'echo verify' },
    { id: 'scope', prompt: 'scope $verify.output', depends_on: ['verify'] },
    { id: 'impl', prompt: 'implement', depends_on: ['scope'] },
  ]);
}

// ---------------------------------------------------------------------------
// Namespacing + edge rewiring
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — namespacing', () => {
  test('inlines the block as flattened, namespaced nodes with no include remaining', () => {
    const parent = wf('parent', [
      { id: 'setup', bash: 'echo setup' },
      { id: 'review', include: 'blk', depends_on: ['setup'] },
      { id: 'summary', prompt: 'summarize $review.output', depends_on: ['review'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('parent')!;
    const ids = expanded.nodes.map(n => n.id);
    expect(ids).toContain('review__verify');
    expect(ids).toContain('review__scope');
    expect(ids).toContain('review__impl');
    expect(ids).not.toContain('review');
    expect(expanded.nodes.some(n => 'include' in n)).toBe(false);
  });

  test('rewires internal depends_on to namespaced ids', () => {
    const parent = wf('parent', [{ id: 'review', include: 'blk' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const expanded = workflows.get('parent')!;
    expect(nodeById(expanded, 'review__scope')?.depends_on).toEqual(['review__verify']);
    expect(nodeById(expanded, 'review__impl')?.depends_on).toEqual(['review__scope']);
  });

  test('entry node inherits the include node upstream deps; sinks feed downstream refs', () => {
    const parent = wf('parent', [
      { id: 'setup', bash: 'echo setup' },
      { id: 'review', include: 'blk', depends_on: ['setup'] },
      { id: 'summary', prompt: 'done', depends_on: ['review'] },
    ]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const expanded = workflows.get('parent')!;
    // Entry (block's `verify`, originally no deps) picks up the include node's deps.
    expect(nodeById(expanded, 'review__verify')?.depends_on).toEqual(['setup']);
    // Downstream `summary` depends_on:[review] rewired to the block's sink (impl).
    expect(nodeById(expanded, 'summary')?.depends_on).toEqual(['review__impl']);
  });

  test('rewrites $includeId.output to the primary sink, and internal refs to namespaced ids', () => {
    const parent = wf('parent', [
      { id: 'review', include: 'blk' },
      { id: 'summary', prompt: 'read $review.output here', depends_on: ['review'] },
    ]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const expanded = workflows.get('parent')!;
    const summary = nodeById(expanded, 'summary');
    expect(summary && 'prompt' in summary ? summary.prompt : '').toBe(
      'read $review__impl.output here'
    );
    // Internal block ref ($verify.output inside scope) namespaced too.
    const scope = nodeById(expanded, 'review__scope');
    expect(scope && 'prompt' in scope ? scope.prompt : '').toBe('scope $review__verify.output');
  });

  test("propagates the include node's when/trigger_rule onto entry nodes", () => {
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      {
        id: 'review',
        include: 'blk',
        depends_on: ['gate'],
        when: 'true',
        trigger_rule: 'all_success',
      },
    ]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const entry = nodeById(workflows.get('parent')!, 'review__verify');
    expect(entry?.when).toBe('true');
    expect(entry?.trigger_rule).toBe('all_success');
  });

  test('two include nodes of the same block get distinct namespaces', () => {
    const parent = wf('parent', [
      { id: 'a', include: 'blk' },
      { id: 'b', include: 'blk', depends_on: ['a'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);
    const ids = workflows.get('parent')!.nodes.map(n => n.id);
    expect(ids).toContain('a__verify');
    expect(ids).toContain('b__verify');
    // b's entry inherits [a] rewired to a's sink.
    expect(nodeById(workflows.get('parent')!, 'b__verify')?.depends_on).toEqual(['a__impl']);
  });

  test('does not mutate the input workflow map', () => {
    const parent = wf('parent', [{ id: 'review', include: 'blk' }]);
    const raw = mapOf(blockWorkflow(), parent);
    expandWorkflowIncludes(raw);
    // The original parent object still carries its include node (untouched).
    expect(raw.get('parent')!.nodes.some(n => 'include' in n)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nested includes
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — nested', () => {
  test('recursively expands a block that itself includes another', () => {
    const leaf = wf('leaf', [{ id: 'x', prompt: 'x' }]);
    const mid = wf('mid', [
      { id: 'm', prompt: 'm' },
      { id: 'inner', include: 'leaf', depends_on: ['m'] },
    ]);
    const parent = wf('parent', [{ id: 'outer', include: 'mid' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, mid, parent));
    expect(errors).toHaveLength(0);
    const ids = workflows.get('parent')!.nodes.map(n => n.id);
    expect(ids).toContain('outer__m');
    expect(ids).toContain('outer__inner__x');
    expect(workflows.get('parent')!.nodes.some(n => 'include' in n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error paths — resilient (drop the bad one, keep the rest)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — errors', () => {
  test('unknown target drops the workflow with a clear error; others survive', () => {
    const bad = wf('bad', [{ id: 'r', include: 'nope' }]);
    const good = wf('good', [{ id: 'only', prompt: 'hi' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(bad, good));
    expect(workflows.has('bad')).toBe(false);
    expect(workflows.has('good')).toBe(true);
    const err = errors.find(e => e.filename === 'bad');
    expect(err?.error).toContain('not found');
    expect(err?.error).toContain("Node 'r'");
  });

  test('self-include is a cycle error', () => {
    const a = wf('a', [{ id: 'r', include: 'a' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(a));
    expect(workflows.has('a')).toBe(false);
    expect(errors[0]?.error).toContain('cycle');
  });

  test('mutual include (a -> b -> a) is a cycle error', () => {
    const a = wf('a', [{ id: 'ra', include: 'b' }]);
    const b = wf('b', [{ id: 'rb', include: 'a' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(a, b));
    expect(workflows.has('a')).toBe(false);
    expect(errors.some(e => e.error.includes('cycle'))).toBe(true);
  });

  test('an include chain deeper than the cap is a depth error', () => {
    // a -> b -> c -> d -> e (4 hops). With INCLUDE_MAX_DEPTH=3 the deepest chains fail.
    const e = wf('e', [{ id: 'x', prompt: 'x' }]);
    const d = wf('d', [{ id: 'r', include: 'e' }]);
    const c = wf('c', [{ id: 'r', include: 'd' }]);
    const b = wf('b', [{ id: 'r', include: 'c' }]);
    const a = wf('a', [{ id: 'r', include: 'b' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(a, b, c, d, e));
    // The two deepest roots exceed the cap and are dropped with a depth error.
    expect(workflows.has('a')).toBe(false);
    expect(errors.find(err => err.filename === 'a')?.error).toContain('depth');
    // Shallow-enough workflows still expand.
    expect(workflows.has('c')).toBe(true);
    expect(workflows.has('d')).toBe(true);
    expect(workflows.has('e')).toBe(true);
    expect(INCLUDE_MAX_DEPTH).toBe(3);
  });

  test('a namespaced id colliding with a hand-written node is a duplicate-id error', () => {
    const blk = wf('blk', [{ id: 'verify', prompt: 'v' }]);
    const parent = wf('parent', [
      { id: 'review__verify', prompt: 'hand-written collision' },
      { id: 'review', include: 'blk' },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(blk, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(err => err.filename === 'parent')?.error).toContain('Duplicate node id');
  });
});

// ---------------------------------------------------------------------------
// Determinism (load-bearing for resume correctness)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — determinism', () => {
  test('expanding the same map twice yields identical node ids and structure', () => {
    const build = () => {
      const parent = wf('parent', [
        { id: 'setup', bash: 'echo setup' },
        { id: 'review', include: 'blk', depends_on: ['setup'] },
        { id: 'summary', prompt: 'summarize $review.output', depends_on: ['review'] },
      ]);
      return expandWorkflowIncludes(mapOf(blockWorkflow(), parent)).workflows.get('parent')!;
    };
    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('include-free workflows pass through unchanged (fast path)', () => {
    const plain = wf('plain', [{ id: 'a', prompt: 'a' }]);
    const raw = mapOf(plain);
    const { workflows, errors } = expandWorkflowIncludes(raw);
    expect(errors).toHaveLength(0);
    // Byte-identical object identity: the fast path returns the raw workflow.
    expect(workflows.get('plain')).toBe(plain);
  });
});
