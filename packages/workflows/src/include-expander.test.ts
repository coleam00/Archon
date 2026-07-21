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
// when-gate combination on entry nodes (include gate must not be discarded)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — when gate combination', () => {
  // Parent with a `gate` node; the include references it via when. The block's entry
  // node carries its OWN when (referencing the same parent node, left intact because
  // `gate` is not a block-internal id).
  function parentWith(includeWhen: string, entryWhen: string): Map<string, WorkflowDefinition> {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e', when: entryWhen }]);
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      { id: 'review', include: 'gated-blk', depends_on: ['gate'], when: includeWhen },
    ]);
    return mapOf(block, parent);
  }

  test('combines the include gate with the entry node own when (both plain, no ||)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go'", "$gate.output == 'yes'")
    );
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__e')?.when).toBe(
      "$gate.output == 'go' && $gate.output == 'yes'"
    );
  });

  test('fails the expansion when the ENTRY own when uses || (precedence would change)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go'", "$gate.output == 'a' || $gate.output == 'b'")
    );
    expect(workflows.has('parent')).toBe(false);
    const err = errors.find(e => e.filename === 'parent');
    expect(err?.error).toContain('cannot combine');
    expect(err?.error).toContain('||');
  });

  test('fails the expansion when the INCLUDE gate uses || (precedence would change)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go' || $gate.output == 'stop'", "$gate.output == 'yes'")
    );
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain('cannot combine');
  });

  test('entry-only when is preserved unchanged when the include has no gate', () => {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e', when: "$gate.output == 'yes'" }]);
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      { id: 'review', include: 'gated-blk', depends_on: ['gate'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__e')?.when).toBe("$gate.output == 'yes'");
  });

  test('include-only gate is applied to an entry that has no when of its own', () => {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e' }]);
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      { id: 'review', include: 'gated-blk', depends_on: ['gate'], when: "$gate.output == 'go'" },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__e')?.when).toBe("$gate.output == 'go'");
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
// Shorthand when: refs ($id.field == $id.output.field) must be renamed too
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — shorthand when: refs', () => {
  test('renames a shorthand $sibling.field ref inside an internal when:', () => {
    const block = wf('shbk', [
      { id: 'sib', bash: 'echo hi' },
      { id: 'e', prompt: 'e', when: "$sib.exit_code == '0'", depends_on: ['sib'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'shbk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    // The shorthand ref (no literal `.output`) is renamed to the namespaced sibling.
    expect(nodeById(workflows.get('parent')!, 'inc__e')?.when).toBe("$inc__sib.exit_code == '0'");
  });

  test('renames a shorthand $includeId.field ref on a downstream parent node', () => {
    const block = wf('blk1', [{ id: 'only', bash: 'echo hi' }]);
    const parent = wf('parent', [
      { id: 'inc', include: 'blk1' },
      { id: 'after', prompt: 'after', when: "$inc.exit_code == '0'", depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    // $inc.exit_code (shorthand to the include id) resolves to the block's primary sink.
    expect(nodeById(workflows.get('parent')!, 'after')?.when).toBe("$inc__only.exit_code == '0'");
  });

  test('still renames the canonical $id.output form in when:', () => {
    const block = wf('blk2', [
      { id: 'a', bash: 'echo a' },
      { id: 'b', prompt: 'b', when: "$a.output == 'x'", depends_on: ['a'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk2' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(block, parent));
    expect(nodeById(workflows.get('parent')!, 'inc__b')?.when).toBe("$inc__a.output == 'x'");
  });
});

// ---------------------------------------------------------------------------
// Fence-aware prose: documentation examples inside prompts must NOT be rewritten
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — fence-aware prose', () => {
  test('rewrites a live prompt ref but leaves a fenced example untouched', () => {
    const block = wf('blk', [
      { id: 'helper', bash: 'echo hi' },
      {
        id: 'writer',
        prompt: 'Live: $helper.output\n```\nexample: $helper.output\n```',
        depends_on: ['helper'],
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const writer = nodeById(workflows.get('parent')!, 'inc__writer');
    const prompt = writer && 'prompt' in writer ? writer.prompt : '';
    // Live ref (outside the fence) renamed…
    expect(prompt).toContain('Live: $inc__helper.output');
    // …fenced example left verbatim.
    expect(prompt).toContain('```\nexample: $helper.output\n```');
  });

  test('bash refs are rewritten verbatim (code fields are not fence-protected)', () => {
    const block = wf('blk', [
      { id: 'a', bash: 'echo a' },
      { id: 'b', bash: 'echo $a.output', depends_on: ['a'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(block, parent));
    const b = nodeById(workflows.get('parent')!, 'inc__b');
    expect(b && 'bash' in b ? b.bash : '').toBe('echo $inc__a.output');
  });

  // #2121 Phase 2: a `workflow:` (sub-run) node inside an included block is a live
  // ref surface — its node id must namespace and its input: refs must rewrite so
  // executeWorkflowNode's re-entry (keyed on the namespaced parent_node_id) and
  // the child's $ARGUMENTS both see the right values.
  test('workflow: node in an included block — id namespaced, input: refs rewritten, target untouched', () => {
    const block = wf('blk', [
      { id: 'plan', bash: 'echo plan' },
      { id: 'sub', workflow: 'child-target', input: 'goal: $plan.output', depends_on: ['plan'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const sub = nodeById(workflows.get('parent')!, 'inc__sub');
    expect(sub).toBeDefined();
    // The sibling ref inside input: is rewritten to the namespaced id…
    expect(sub && 'input' in sub ? sub.input : '').toBe('goal: $inc__plan.output');
    // …but the sub-run TARGET is a workflow name, not a node ref — never rewritten.
    expect(sub && 'workflow' in sub ? sub.workflow : '').toBe('child-target');
  });
});

// ---------------------------------------------------------------------------
// Command-file ref scan (contents can't be rewritten → fail-fast at load time)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — command-file ref scan', () => {
  function blockWithCommand(): [WorkflowDefinition, WorkflowDefinition] {
    const block = wf('cmdblk', [
      { id: 'sib', bash: 'echo hi' },
      { id: 'runner', command: 'my-cmd', depends_on: ['sib'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'cmdblk' }]);
    return [block, parent];
  }

  test('fails when a block command file references a renamed sibling id', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Process the results from $sib.output and summarize.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(workflows.has('parent')).toBe(false);
    const err = errors.find(e => e.filename === 'parent');
    expect(err?.error).toContain("command file 'my-cmd.md'");
    expect(err?.error).toContain("sibling node '$sib'");
  });

  test('passes when the command file has no cross-node reference', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Work from $ARTIFACTS_DIR only. See `$sib.output` in fenced docs.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    // The only $sib.output is inside inline code (stripped), so no live ref → clean.
    expect(errors).toHaveLength(0);
    expect(workflows.has('parent')).toBe(true);
  });

  test('does not fail expansion when the command file is unresolvable (null)', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([['my-cmd', null]]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    // Unresolvable → warn (asserted in loader.test.ts), never a hard error.
    expect(errors).toHaveLength(0);
    expect(workflows.has('parent')).toBe(true);
  });

  test('skips the scan entirely when no commandContents map is supplied', () => {
    const [block, parent] = blockWithCommand();
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(workflows.has('parent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loop_group inside an included block
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — loop_group in an included block', () => {
  test('renames outer-sibling refs but leaves body ids and $LOOP_PREV refs body-local', () => {
    const block = wf('lgblk', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'lg',
        depends_on: ['seed'],
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          nodes: [
            {
              id: 'inner',
              prompt: 'prev=$LOOP_PREV.inner.output outer=$seed.output',
              depends_on: [],
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'rev', include: 'lgblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('parent')!;
    // The loop_group NODE is namespaced; the outer sibling `seed` is too.
    expect(expanded.nodes.map(n => n.id)).toContain('rev__lg');
    const lg = expanded.nodes.find(n => n.id === 'rev__lg') as {
      loop_group: { nodes: { id: string; prompt: string }[] };
    };
    // Body node id is NOT renamed (body-local), so its $LOOP_PREV.<bodyId> ref is preserved,
    // while the outer-sibling ref ($seed.output) IS rewritten to the namespaced id.
    expect(lg.loop_group.nodes[0].id).toBe('inner');
    expect(lg.loop_group.nodes[0].prompt).toBe(
      'prev=$LOOP_PREV.inner.output outer=$rev__seed.output'
    );
  });

  test('a loop_group body id shadowing a parent top-level id is rejected', () => {
    const block = wf('lgblk', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'lg',
        depends_on: ['seed'],
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [{ id: 'clash', prompt: 'work', depends_on: [] }],
        },
      },
    ]);
    // Parent has a top-level node whose id equals the block's loop_group body id.
    const parent = wf('parent', [
      { id: 'clash', bash: 'echo clash' },
      { id: 'rev', include: 'lgblk' },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain('shadows');
  });
});

// ---------------------------------------------------------------------------
// Composition: persist_session isolation + diamond includes
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — composition', () => {
  test('persist_session survives inlining and namespaces per parent (independent keys)', () => {
    const block = wf('sesblk', [{ id: 'ai', prompt: 'do work', persist_session: true }]);
    const parentA = wf('parentA', [{ id: 'rev', include: 'sesblk' }]);
    const parentB = wf('parentB', [{ id: 'rev', include: 'sesblk' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parentA, parentB));
    expect(errors).toHaveLength(0);

    const a = workflows.get('parentA')!;
    const b = workflows.get('parentB')!;
    const aNode = a.nodes.find(n => n.id === 'rev__ai') as { persist_session?: boolean };
    const bNode = b.nodes.find(n => n.id === 'rev__ai') as { persist_session?: boolean };
    expect(aNode?.persist_session).toBe(true);
    expect(bNode?.persist_session).toBe(true);
    // The persisted-session store key is (workflow_name, node_id, scope, provider): the
    // node_id matches, but workflow_name differs (parentA vs parentB), so the two inclusions
    // keep independent session memory.
    expect(a.name).not.toBe(b.name);
  });

  test('diamond include: two blocks both including the same leaf expand without collision', () => {
    const leaf = wf('leaf', [{ id: 'x', prompt: 'x' }]);
    const b1 = wf('b1', [{ id: 'l', include: 'leaf' }]);
    const b2 = wf('b2', [{ id: 'l', include: 'leaf' }]);
    const parent = wf('parent', [
      { id: 'a', include: 'b1' },
      { id: 'b', include: 'b2' },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, b1, b2, parent));
    expect(errors).toHaveLength(0);
    const ids = workflows.get('parent')!.nodes.map(n => n.id);
    // The shared leaf node appears once per path, under distinct nested namespaces.
    expect(ids).toContain('a__l__x');
    expect(ids).toContain('b__l__x');
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
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

  test('honors "up to N levels": an N-level chain expands, N+1 fails', () => {
    // Chain a -> b -> c -> d -> e. INCLUDE_MAX_DEPTH=3, and the cap is `> N` so exactly N
    // include levels are allowed (matching the "up to 3 levels deep" doc contract).
    const e = wf('e', [{ id: 'x', prompt: 'x' }]);
    const d = wf('d', [{ id: 'r', include: 'e' }]);
    const c = wf('c', [{ id: 'r', include: 'd' }]);
    const b = wf('b', [{ id: 'r', include: 'c' }]);
    const a = wf('a', [{ id: 'r', include: 'b' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(a, b, c, d, e));
    expect(INCLUDE_MAX_DEPTH).toBe(3);
    // a -> b -> c -> d -> e is 4 include levels → over the cap → dropped with a depth error.
    expect(workflows.has('a')).toBe(false);
    expect(errors.find(err => err.filename === 'a')?.error).toContain('depth');
    // b -> c -> d -> e is exactly 3 levels → the boundary is allowed.
    expect(workflows.has('b')).toBe(true);
    expect(workflows.has('c')).toBe(true);
    expect(workflows.has('d')).toBe(true);
    expect(workflows.has('e')).toBe(true);
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
