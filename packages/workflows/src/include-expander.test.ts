import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes, INCLUDE_MAX_DEPTH } from './include-expander';
import { dagNodeSchema } from './schemas';
import type { WorkflowDefinition, DagNode } from './schemas';
import {
  COMPILED_LOOP_COMMAND,
  COMPOSED_NODE,
  type ComposedNodeMeta,
  type LoopWithCompiledCommand,
  type NodeWithComposedMeta,
} from './compiled-command';

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

function composedMeta(node: DagNode | undefined): ComposedNodeMeta | undefined {
  return node === undefined ? undefined : (node as DagNode & NodeWithComposedMeta)[COMPOSED_NODE];
}

function composedInputs(node: DagNode | undefined): Record<string, string> | undefined {
  return composedMeta(node)?.inputs;
}

function composedOrigin(node: DagNode | undefined): string | undefined {
  return composedMeta(node)?.origin;
}

function compiledLoopPrompt(node: DagNode | undefined): string | undefined {
  if (!node || !('loop' in node)) return undefined;
  return (node.loop as typeof node.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]?.prompt;
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
// Load-time include inputs
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — with input mapping', () => {
  test('inlines literals, preserves caller refs, and still namespaces internal refs', () => {
    const block = wf('parameterized', [
      { id: 'gather', bash: 'echo child' },
      {
        id: 'judge',
        prompt: 'Plan: $INPUTS.plan; scope: $gather.output; base: $INPUTS.base',
        depends_on: ['gather'],
      },
    ]);
    const parent = wf('parent', [
      { id: 'plan', bash: 'echo parent plan' },
      {
        id: 'review',
        include: 'parameterized',
        depends_on: ['plan'],
        with: { plan: '$plan.output', base: 'main' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const judge = nodeById(workflows.get('parent')!, 'review__judge');
    expect(judge && 'prompt' in judge ? judge.prompt : '').toBe(
      'Plan: $plan.output; scope: $review__gather.output; base: main'
    );
  });

  test('rejects an injected dangling output ref during flattened validation', () => {
    const block = wf('parameterized', [{ id: 'judge', prompt: 'Plan: $INPUTS.plan' }]);
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { plan: '$nosuch.output' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "Node 'review__judge' field 'prompt' references unknown node '$nosuch.output'"
    );
  });

  test('rejects missing inputs with include and block context', () => {
    const block = wf('parameterized', [
      { id: 'judge', prompt: 'Use $INPUTS.scope and $INPUTS.base' },
    ]);
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { unused: 'allowed' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain("Node 'review'");
    expect(message).toContain("included block 'parameterized'");
    expect(message).toContain('$INPUTS.base, $INPUTS.scope');
  });

  // `$INPUTS` has no runtime resolution pass — load-time expansion is the ONLY path
  // that resolves it. A surface the macro skips therefore delivers literal
  // `$INPUTS.<name>` text to the model forever, and is never recorded in
  // missingInputs either, so a caller who forgot the value gets no load error.
  test('substitutes the AI-turn surfaces that have no runtime second chance', () => {
    const block = wf('parameterized', [
      {
        id: 'work',
        prompt: 'Main: $INPUTS.detail',
        systemPrompt: 'You handle $INPUTS.detail',
        agents: {
          helper: {
            description: 'Handles $INPUTS.detail',
            prompt: 'Sub-task: $INPUTS.detail',
          },
        },
      },
      {
        id: 'gate',
        approval: {
          message: 'Approve $INPUTS.detail?',
          on_reject: { prompt: 'Retry with $INPUTS.detail' },
        },
      },
    ]);
    // `interactive: true` because the block carries an approval gate — a composed gate a
    // background run cannot drive is a load error (#1764).
    const parent = {
      ...wf('parent', [
        { id: 'review', include: 'parameterized', with: { detail: 'CLEAN-TEMP-FILES' } },
      ]),
      interactive: true,
    };

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    expect(nodeById(expanded, 'review__work')).toMatchObject({
      prompt: 'Main: CLEAN-TEMP-FILES',
      systemPrompt: 'You handle CLEAN-TEMP-FILES',
      agents: {
        helper: {
          description: 'Handles CLEAN-TEMP-FILES',
          prompt: 'Sub-task: CLEAN-TEMP-FILES',
        },
      },
    });
    expect(nodeById(expanded, 'review__gate')).toMatchObject({
      approval: {
        message: 'Approve CLEAN-TEMP-FILES?',
        on_reject: { prompt: 'Retry with CLEAN-TEMP-FILES' },
      },
    });
  });

  test('an unsupplied input on those same surfaces fails the load', () => {
    const block = wf('parameterized', [
      {
        id: 'work',
        prompt: 'no refs here',
        systemPrompt: 'You handle $INPUTS.fromSystem',
        agents: { helper: { description: 'd', prompt: 'Sub: $INPUTS.fromAgent' } },
      },
      {
        id: 'gate',
        approval: { message: 'ok?', on_reject: { prompt: 'Retry $INPUTS.fromReject' } },
      },
      { id: 'fan', workflow: 'child', fan_out: { items: '$INPUTS.fromFanOut' } },
    ]);
    const parent = wf('parent', [{ id: 'review', include: 'parameterized' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain('$INPUTS.fromAgent');
    expect(message).toContain('$INPUTS.fromFanOut');
    expect(message).toContain('$INPUTS.fromReject');
    expect(message).toContain('$INPUTS.fromSystem');
  });

  // Inherited Object.prototype members are not supplied inputs. Reading them with a
  // plain `args[name]` lookup substitutes a native function body into the prompt
  // instead of reporting the input as missing.
  test('an inherited property name is treated as missing, not as a value', () => {
    const block = wf('parameterized', [
      { id: 'use', prompt: 'a=$INPUTS.toString b=$INPUTS.constructor c=$INPUTS.__proto__' },
    ]);
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { unrelated: 'x' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain('$INPUTS.__proto__');
    expect(message).toContain('$INPUTS.constructor');
    expect(message).toContain('$INPUTS.toString');
    expect(message).not.toContain('native code');
  });

  test('an own property that shadows an inherited name still substitutes', () => {
    const block = wf('parameterized', [{ id: 'use', prompt: 'v=$INPUTS.toString' }]);
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { toString: 'literal-value' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const use = nodeById(workflows.get('parent')!, 'review__use');
    expect(use && 'prompt' in use ? use.prompt : '').toBe('v=literal-value');
  });

  test('two callers substitute independently', () => {
    const block = wf('parameterized', [{ id: 'use', prompt: 'Use $INPUTS.value' }]);
    const parent = wf('parent', [
      { id: 'first', include: 'parameterized', with: { value: 'alpha' } },
      { id: 'second', include: 'parameterized', with: { value: 'beta' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    const first = nodeById(expanded, 'first__use');
    const second = nodeById(expanded, 'second__use');
    expect(first && 'prompt' in first ? first.prompt : '').toBe('Use alpha');
    expect(second && 'prompt' in second ? second.prompt : '').toBe('Use beta');
  });

  test('keeps an injected parent ref parent-scoped when a child id collides', () => {
    const block = wf('parameterized', [
      { id: 'gather', bash: 'echo child' },
      {
        id: 'use',
        prompt: 'Parent: $INPUTS.plan; child: $gather.output',
        depends_on: ['gather'],
      },
    ]);
    const parent = wf('parent', [
      { id: 'gather', bash: 'echo parent' },
      {
        id: 'review',
        include: 'parameterized',
        depends_on: ['gather'],
        with: { plan: '$gather.output' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const use = nodeById(workflows.get('parent')!, 'review__use');
    expect(use && 'prompt' in use ? use.prompt : '').toBe(
      'Parent: $gather.output; child: $review__gather.output'
    );
  });

  test('forwards an input through a nested include', () => {
    const leaf = wf('leaf', [{ id: 'use', prompt: 'Leaf: $INPUTS.value' }]);
    const middle = wf('middle', [
      { id: 'inner', include: 'leaf', with: { value: '$INPUTS.forwarded' } },
    ]);
    const parent = wf('parent', [
      { id: 'plan', bash: 'echo plan' },
      {
        id: 'outer',
        include: 'middle',
        depends_on: ['plan'],
        with: { forwarded: '$plan.output' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, parent));
    expect(errors).toHaveLength(0);
    const use = nodeById(workflows.get('parent')!, 'outer__inner__use');
    expect(use && 'prompt' in use ? use.prompt : '').toBe('Leaf: $plan.output');
  });

  test('substitutes in when expressions and inside fenced text', () => {
    const block = wf('parameterized', [
      {
        id: 'use',
        prompt: '```\n$INPUTS.example $INPUTS.example\n``` empty=[$INPUTS.empty]',
        when: "$INPUTS.condition == 'go'",
      },
    ]);
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo go' },
      {
        id: 'review',
        include: 'parameterized',
        depends_on: ['gate'],
        with: { example: 'literal', empty: '', condition: '$gate.output' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const use = nodeById(workflows.get('parent')!, 'review__use');
    expect(use?.when).toBe("$gate.output == 'go'");
    expect(use && 'prompt' in use ? use.prompt : '').toBe('```\nliteral literal\n``` empty=[]');
  });

  test('substitutes inputs across every other supported inline node surface', () => {
    const block = wf('parameterized', [
      { id: 'shell', bash: 'echo $INPUTS.value' },
      { id: 'script', runtime: 'bun', script: 'console.log("$INPUTS.value")' },
      {
        id: 'loop',
        loop: {
          prompt: 'Do $INPUTS.value',
          until: 'DONE',
          max_iterations: 1,
          until_bash: 'test "$INPUTS.value" = done',
        },
      },
      { id: 'approval', approval: { message: 'Approve $INPUTS.value?' } },
      { id: 'cancel', cancel: 'Stop: $INPUTS.value' },
      {
        id: 'subrun',
        workflow: 'child',
        input: 'scope=$INPUTS.value',
        fan_out: { items: '["$INPUTS.value"]' },
      },
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          until_bash: 'test "$INPUTS.value" = done',
          nodes: [{ id: 'body', bash: 'echo $INPUTS.value' }],
        },
      },
    ]);
    const parent = {
      ...wf('parent', [{ id: 'review', include: 'parameterized', with: { value: 'done' } }]),
      interactive: true, // the block carries an approval gate (#1764)
    };

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    const loop = nodeById(expanded, 'review__loop');
    const approval = nodeById(expanded, 'review__approval');
    const group = nodeById(expanded, 'review__group');
    expect(nodeById(expanded, 'review__shell')).toMatchObject({ bash: 'echo done' });
    expect(nodeById(expanded, 'review__script')).toMatchObject({ script: 'console.log("done")' });
    expect(loop).toMatchObject({
      loop: { prompt: 'Do done', until_bash: 'test "done" = done' },
    });
    expect(approval).toMatchObject({ approval: { message: 'Approve done?' } });
    expect(nodeById(expanded, 'review__cancel')).toMatchObject({ cancel: 'Stop: done' });
    expect(nodeById(expanded, 'review__subrun')).toMatchObject({
      input: 'scope=done',
      // fan_out.items is a live data-string surface that rewriteNodeOutputRefs already
      // walks; the macro must walk it too or the literal reaches the executor, which
      // JSON.parses it and spawns a child per unsubstituted placeholder.
      fan_out: { items: '["done"]' },
    });
    expect(group).toMatchObject({
      loop_group: {
        until_bash: 'test "done" = done',
        nodes: [{ id: 'body', bash: 'echo done' }],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// when-gate combination on entry nodes (include gate must not be discarded)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — when gate combination', () => {
  function parentWith(includeWhen: string, entryWhen: string): Map<string, WorkflowDefinition> {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e', when: entryWhen }]);
    block.inputs = { gate: { required: true } };
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      {
        id: 'review',
        include: 'gated-blk',
        depends_on: ['gate'],
        when: includeWhen,
        with: { gate: '$gate.output' },
      },
    ]);
    return mapOf(block, parent);
  }

  test('combines the include gate with the entry node own when (both plain, no ||)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go'", "$INPUTS.gate == 'yes'")
    );
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__e')?.when).toBe(
      "$gate.output == 'go' && $gate.output == 'yes'"
    );
  });

  test('fails the expansion when the ENTRY own when uses || (precedence would change)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go'", "$INPUTS.gate == 'a' || $INPUTS.gate == 'b'")
    );
    expect(workflows.has('parent')).toBe(false);
    const err = errors.find(e => e.filename === 'parent');
    expect(err?.error).toContain('cannot combine');
    expect(err?.error).toContain('||');
  });

  test('fails the expansion when the INCLUDE gate uses || (precedence would change)', () => {
    const { workflows, errors } = expandWorkflowIncludes(
      parentWith("$gate.output == 'go' || $gate.output == 'stop'", "$INPUTS.gate == 'yes'")
    );
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain('cannot combine');
  });

  test('entry-only when is preserved unchanged when the include has no gate', () => {
    const block = wf('gated-blk', [{ id: 'e', prompt: 'e', when: "$INPUTS.gate == 'yes'" }]);
    block.inputs = { gate: { required: true } };
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      {
        id: 'review',
        include: 'gated-blk',
        depends_on: ['gate'],
        with: { gate: '$gate.output' },
      },
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

  test('preserves a nested compiled loop command across three-level composition', () => {
    const leaf = wf('leaf-loop', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'group',
        depends_on: ['seed'],
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'repeat',
              loop: { command: 'leaf-loop-command', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    leaf.inputs = { context: { required: true } };
    const middle = wf('middle-loop', [
      { id: 'inner', include: 'leaf-loop', with: { context: 'bound value' } },
    ]);
    const parent = wf('parent', [{ id: 'outer', include: 'middle-loop' }]);

    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(leaf, middle, parent),
      new Map([['leaf-loop-command', 'Use $seed.output with $INPUTS.context and continue.']])
    );

    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'outer__inner__group');
    const repeat = group && 'loop_group' in group ? group.loop_group.nodes[0] : undefined;
    expect(compiledLoopPrompt(repeat)).toBe(
      'Use $outer__inner__seed.output with bound value and continue.'
    );
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

  test('rejects an external shorthand ref even when the parent has a colliding id', () => {
    const block = wf('blk3', [{ id: 'task', prompt: 'work', when: "$caller.status == 'ok'" }]);
    const parent = wf('parent', [
      { id: 'caller', bash: 'echo parent' },
      { id: 'inc', include: 'blk3', depends_on: ['caller'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "field 'when' references unknown node '$caller.status'"
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown code spans are live because runtime substitution is syntax-agnostic
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — refs in Markdown code spans', () => {
  test('rewrites refs both outside and inside a fenced example', () => {
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
    expect(prompt).toContain('Live: $inc__helper.output');
    expect(prompt).toContain('```\nexample: $inc__helper.output\n```');
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

  test('rewrites approval rejection prompts to the included sibling namespace', () => {
    const block = wf('approval-block', [
      { id: 'plan', prompt: 'plan' },
      {
        id: 'gate',
        approval: {
          message: 'Approve $plan.output',
          on_reject: { prompt: 'Revise $plan.output' },
        },
        depends_on: ['plan'],
      },
    ]);
    const parent = {
      ...wf('parent', [
        { id: 'plan', prompt: 'parent plan' },
        { id: 'inc', include: 'approval-block', depends_on: ['plan'] },
      ]),
      interactive: true, // the block carries an approval gate (#1764)
    };
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const gate = nodeById(workflows.get('parent')!, 'inc__gate');
    expect(gate && 'approval' in gate ? gate.approval.message : '').toBe(
      'Approve $inc__plan.output'
    );
    expect(gate && 'approval' in gate ? gate.approval.on_reject?.prompt : '').toBe(
      'Revise $inc__plan.output'
    );
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

  // slice 2, PR-C: fan_out.items is a live `$node.output` ref surface too — it must
  // namespace to the inlined producer so the fan-out expands over the right array.
  test('fan_out.items refs rewritten inside an included block', () => {
    const block = wf('fanblk', [
      { id: 'plan', bash: 'echo tasks' },
      {
        id: 'work',
        workflow: 'child-target',
        depends_on: ['plan'],
        fan_out: { items: '$plan.output.tasks' },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'fanblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const work = nodeById(workflows.get('parent')!, 'inc__work');
    expect(work).toBeDefined();
    // The producer ref inside fan_out.items is rewritten to the namespaced id…
    expect(work && 'fan_out' in work ? work.fan_out?.items : '').toBe('$inc__plan.output.tasks');
    // …the sub-run TARGET is a workflow name — never rewritten.
    expect(work && 'workflow' in work ? work.workflow : '').toBe('child-target');
  });
});

// ---------------------------------------------------------------------------
// Included command compilation (resolved bodies become namespaced inline prompts)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — included command compilation', () => {
  function blockWithCommand(): [WorkflowDefinition, WorkflowDefinition] {
    const block = wf('cmdblk', [
      { id: 'sib', bash: 'echo hi' },
      { id: 'runner', command: 'my-cmd', depends_on: ['sib'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'cmdblk' }]);
    return [block, parent];
  }

  test('materializes a block command and namespaces its local sibling ref', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Process the results from $sib.output and summarize.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(runner && 'prompt' in runner ? runner.prompt : '').toBe(
      'Process the results from $inc__sib.output and summarize.'
    );
    expect(runner && 'command' in runner).toBe(false);
  });

  test('materializes a command body and binds its declared include input', () => {
    const [block, parent] = blockWithCommand();
    block.inputs = { scope: { required: true } };
    const includeNode = parent.nodes[0];
    if (includeNode && 'include' in includeNode) includeNode.with = { scope: 'prod' };
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Review scope $INPUTS.scope.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(runner && 'prompt' in runner ? runner.prompt : '').toBe('Review scope prod.');
  });

  test('binds a declared include input named output in an ordinary command', () => {
    const [block, parent] = blockWithCommand();
    block.inputs = { output: { required: true } };
    const includeNode = parent.nodes[0];
    if (includeNode && 'include' in includeNode) includeNode.with = { output: 'bound value' };
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['my-cmd', 'Review $INPUTS.output.']])
    );
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(runner && 'prompt' in runner ? runner.prompt : '').toBe('Review bound value.');
  });

  test('keeps a caller ref passed through a command input parent-scoped on id collision', () => {
    const block = wf('collision-command-block', [
      { id: 'gather', prompt: 'local gather' },
      { id: 'runner', command: 'collision-command', depends_on: ['gather'] },
    ]);
    block.inputs = { context: { required: true } };
    const parent = wf('parent', [
      { id: 'gather', prompt: 'parent gather' },
      {
        id: 'inc',
        include: 'collision-command-block',
        depends_on: ['gather'],
        with: { context: '$gather.output' },
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['collision-command', 'Review $INPUTS.context.']])
    );
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(runner && 'prompt' in runner ? runner.prompt : '').toBe('Review $gather.output.');
  });

  test('treats canonical refs inside Markdown code as live and namespaces them', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Work from $ARTIFACTS_DIR only. See `$sib.output` in fenced docs.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(runner && 'prompt' in runner ? runner.prompt : '').toContain('`$inc__sib.output`');
  });

  test('binds a declared include input inside a fenced block', () => {
    const [block, parent] = blockWithCommand();
    block.inputs = { scope: { required: true } };
    const includeNode = parent.nodes[0];
    if (includeNode && 'include' in includeNode) includeNode.with = { scope: 'prod' };
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Run this:\n\n```bash\necho "$INPUTS.scope"\n```\n'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(runner && 'prompt' in runner ? runner.prompt : '').toContain('echo "prod"');
  });

  test('rejects a command ref outside the included workflow namespace', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Use $caller.output directly.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain("included workflow 'cmdblk'");
    expect(message).toContain("node 'runner'");
    expect(message).toContain("command 'my-cmd'");
    expect(message).toContain("'$caller.output'");
    expect(message).toContain('inputs:');
    expect(message).toContain('with:');
  });

  test('rejects the same external command ref when the parent has a colliding id', () => {
    const [block] = blockWithCommand();
    const parent = wf('parent', [
      { id: 'caller', bash: 'echo parent' },
      { id: 'inc', include: 'cmdblk', depends_on: ['caller'] },
    ]);
    const result = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['my-cmd', 'Use $caller.output directly.']])
    );
    expect(result.workflows.has('parent')).toBe(false);
    expect(result.errors.find(error => error.filename === 'parent')?.error).toContain(
      "'$caller.output'"
    );
  });

  test('fails closed when the command body cannot be resolved', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([['my-cmd', null]]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain("command 'my-cmd'");
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      'could not be resolved during composition'
    );
  });

  test('rejects an empty command body during composition', () => {
    const [block, parent] = blockWithCommand();
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['my-cmd', '  \n\t']])
    );
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain("command 'my-cmd' is empty");
    expect(message).toContain('non-whitespace prompt body');
  });

  test('materializes loop.command and binds its declared include input', () => {
    const block = wf('loopblk', [
      { id: 'repeat', loop: { command: 'loop-cmd', until: 'DONE', max_iterations: 1 } },
    ]);
    block.inputs = { scope: { required: true } };
    const parent = wf('parent', [{ id: 'inc', include: 'loopblk', with: { scope: 'prod' } }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['loop-cmd', 'Review $INPUTS.scope.']])
    );
    expect(errors).toHaveLength(0);
    const repeat = nodeById(workflows.get('parent')!, 'inc__repeat');
    expect(compiledLoopPrompt(repeat)).toBe('Review prod.');
    expect(repeat && 'loop' in repeat ? repeat.loop.command : undefined).toBe('loop-cmd');
  });

  test('binds a declared include input named output in a loop command', () => {
    const block = wf('loop-output-block', [
      { id: 'repeat', loop: { command: 'loop-output-cmd', until: 'DONE', max_iterations: 1 } },
    ]);
    block.inputs = { output: { required: true } };
    const parent = wf('parent', [
      { id: 'inc', include: 'loop-output-block', with: { output: 'bound value' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['loop-output-cmd', 'Review $INPUTS.output.']])
    );
    expect(errors).toHaveLength(0);
    expect(compiledLoopPrompt(nodeById(workflows.get('parent')!, 'inc__repeat'))).toBe(
      'Review bound value.'
    );
  });

  test('keeps a whitespace-only loop command as an actionable compiled error', () => {
    const block = wf('empty-loop-block', [
      { id: 'repeat', loop: { command: 'empty-loop-cmd', until: 'DONE', max_iterations: 1 } },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'empty-loop-block' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['empty-loop-cmd', '  \n\t']])
    );
    expect(errors).toHaveLength(0);
    const repeat = nodeById(workflows.get('parent')!, 'inc__repeat');
    const compiled =
      repeat && 'loop' in repeat
        ? (repeat.loop as typeof repeat.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]
        : undefined;
    expect(compiled?.error).toContain("command 'empty-loop-cmd' is empty");
  });

  test('materializes a nested loop command and namespaces an enclosing top-level ref', () => {
    const block = wf('nested-loopblk', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'repeat',
              loop: { command: 'nested-loop-cmd', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'nested-loopblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['nested-loop-cmd', 'Read $seed.output and continue.']])
    );
    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'inc__group');
    const repeat = group && 'loop_group' in group ? group.loop_group.nodes[0] : undefined;
    expect(compiledLoopPrompt(repeat)).toBe('Read $inc__seed.output and continue.');
  });

  test('materializes a command inside a second-level nested loop group', () => {
    const block = wf('deep-command-block', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'outer',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'inner',
              loop_group: {
                until: 'DONE',
                max_iterations: 1,
                nodes: [{ id: 'review', command: 'deep-command' }],
              },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'deep-command-block' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['deep-command', 'Read $seed.output and continue.']])
    );

    expect(errors).toHaveLength(0);
    const outer = nodeById(workflows.get('parent')!, 'inc__outer');
    const inner = outer && 'loop_group' in outer ? outer.loop_group.nodes[0] : undefined;
    const review = inner && 'loop_group' in inner ? inner.loop_group.nodes[0] : undefined;
    expect(review && 'prompt' in review ? review.prompt : '').toBe(
      'Read $inc__seed.output and continue.'
    );
  });

  test('binds an include input in a nested loop command', () => {
    const block = wf('nested-input-loopblk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'repeat',
              loop: { command: 'nested-input-cmd', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [
      { id: 'inc', include: 'nested-input-loopblk', with: { scope: 'prod' } },
    ]);
    block.inputs = { scope: { required: true } };
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['nested-input-cmd', 'Review $INPUTS.scope.']])
    );
    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'inc__group');
    const repeat = group && 'loop_group' in group ? group.loop_group.nodes[0] : undefined;
    expect(compiledLoopPrompt(repeat)).toBe('Review prod.');
  });

  test('passes when a nested loop command file references a local body node', () => {
    const block = wf('nested-local-loopblk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            { id: 'seed', bash: 'echo seed' },
            {
              id: 'repeat',
              loop: { command: 'nested-local-cmd', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'nested-local-loopblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['nested-local-cmd', 'Read $seed.output and continue.']])
    );
    expect(errors).toHaveLength(0);
    expect(workflows.has('parent')).toBe(true);
  });

  test('fails closed when no commandContents map is supplied', () => {
    const [block, parent] = blockWithCommand();
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors).toHaveLength(1);
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

  test('include-free workflows are collapsed too, so composition cannot change behaviour', () => {
    // There is no byte-for-byte fast path any more (#1764). Collapsing only workflows that
    // happen to contain an `include:` would make a workflow's own nodes resolve differently
    // depending on an unrelated authoring choice, which is the defect this fixes.
    const plain: WorkflowDefinition = {
      ...wf('plain', [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b', provider: 'codex' },
      ]),
      provider: 'pi',
      model: 'large',
    };
    const { workflows, errors } = expandWorkflowIncludes(mapOf(plain));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('plain')!;
    expect(expanded).not.toBe(plain);
    expect(expanded.provider).toBeUndefined();
    expect(expanded.model).toBeUndefined();
    expect(nodeById(expanded, 'a')).toMatchObject({ provider: 'pi', model: 'large' });
    // The node's own value always wins over the workflow's — and a node that switches
    // provider does NOT inherit the other provider's model string, matching what the
    // executor does with a workflow-level model today.
    expect(nodeById(expanded, 'b')).toMatchObject({ provider: 'codex' });
    expect((nodeById(expanded, 'b') as Record<string, unknown>).model).toBeUndefined();
    // The input is never mutated — discovery hands the same object to display surfaces.
    expect(plain.provider).toBe('pi');
  });
});

// ---------------------------------------------------------------------------
// returns: + declared inputs: (#2470)
// ---------------------------------------------------------------------------

/** Add workflow-level signature fields to a block. */
function withSignature(
  base: WorkflowDefinition,
  sig: { returns?: string; inputs?: WorkflowDefinition['inputs'] }
): WorkflowDefinition {
  return { ...base, ...sig };
}

describe('expandWorkflowIncludes — returns drives primarySink (#2470)', () => {
  test('$blk.output resolves to the declared returns node (a non-sink); depends_on still waits on the sink', () => {
    // Block: synthesize -> implement (implement is the sole sink; synthesize is NOT).
    const block = withSignature(
      wf('review-block', [
        { id: 'synthesize', prompt: 'synthesize' },
        { id: 'implement', prompt: 'implement $synthesize.output', depends_on: ['synthesize'] },
      ]),
      { returns: 'synthesize' }
    );
    const parent = wf('parent', [
      { id: 'blk', include: 'review-block' },
      { id: 'consume', prompt: 'result: $blk.output', depends_on: ['blk'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const consume = nodeById(workflows.get('parent')!, 'consume')!;
    // $blk.output → the returns node (synthesize), NOT the positional first sink (implement).
    expect('prompt' in consume ? consume.prompt : '').toBe('result: $blk__synthesize.output');
    // depends_on: [blk] still expands to the block's sink (implement), so the wait is intact.
    expect(consume.depends_on).toContain('blk__implement');
  });

  test('rewrites workflow-level returns when it names an included block', () => {
    const inner = withSignature(
      wf('inner', [
        { id: 'result', prompt: 'result' },
        { id: 'cleanup', prompt: 'cleanup', depends_on: ['result'] },
      ]),
      { returns: 'result' }
    );
    const outer = withSignature(wf('outer', [{ id: 'blk', include: 'inner' }]), {
      returns: 'blk',
    });
    const parent = wf('parent', [
      { id: 'outer', include: 'outer' },
      { id: 'consume', prompt: 'value: $outer.output', depends_on: ['outer'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, outer, parent));
    expect(errors).toHaveLength(0);
    // The expanded outer definition no longer contains the include id `blk`, so its
    // contract must follow the include's declared primary sink.
    expect(workflows.get('outer')?.returns).toBe('blk__result');
    // A caller including that outer workflow observes the same return selection.
    const consume = nodeById(workflows.get('parent')!, 'consume')!;
    expect('prompt' in consume ? consume.prompt : '').toBe('value: $outer__blk__result.output');
  });
});

describe('expandWorkflowIncludes — with vs declared inputs (#2470)', () => {
  test('applies a declared default for an omitted input', () => {
    const block = withSignature(wf('blk', [{ id: 'work', prompt: 'style: $INPUTS.style' }]), {
      inputs: { style: { default: 'strict' } },
    });
    const parent = wf('parent', [{ id: 'blk', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const work = nodeById(workflows.get('parent')!, 'blk__work')!;
    expect('prompt' in work ? work.prompt : '').toBe('style: strict');
  });

  test('errors on a missing required input', () => {
    const block = withSignature(wf('blk', [{ id: 'work', prompt: 'diff: $INPUTS.diff' }]), {
      inputs: { diff: { required: true } },
    });
    const parent = wf('parent', [{ id: 'blk', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain("requires input 'diff'");
  });

  test('errors on a caller with: key the block does not declare', () => {
    const block = withSignature(wf('blk', [{ id: 'work', prompt: 'x' }]), {
      inputs: { known: { default: 'v' } },
    });
    const parent = wf('parent', [{ id: 'blk', include: 'blk', with: { unknown: 'oops' } }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain(
      "does not declare input 'unknown'"
    );
  });

  test('a block with NO declared inputs keeps Phase-1 passthrough (undeclared key accepted)', () => {
    const block = wf('blk', [{ id: 'work', prompt: 'v: $INPUTS.v' }]);
    const parent = wf('parent', [
      { id: 'blk', include: 'blk', with: { v: 'hello', extra: 'ignored' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const work = nodeById(workflows.get('parent')!, 'blk__work')!;
    expect('prompt' in work ? work.prompt : '').toBe('v: hello');
  });
});

describe('expandWorkflowIncludes — workflow: node `with:` values (#2470)', () => {
  test('namespaces child-local node refs and substitutes $INPUTS in every with: value', () => {
    // Block: a local node whose output is forwarded to a child workflow alongside
    // an `$INPUTS`-sourced value. Both surfaces live in `with:`, which the
    // expander must walk exactly like `input:` and `fan_out.items`.
    const block = withSignature(
      wf('caller-blk', [
        { id: 'local', bash: 'echo hi' },
        {
          id: 'call',
          workflow: 'child',
          depends_on: ['local'],
          with: { payload: '$local.output', style: '$INPUTS.style' },
        },
      ]),
      { inputs: { style: { default: 'strict' } } }
    );
    const parent = wf('parent', [{ id: 'outer', include: 'caller-blk' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    const call = nodeById(workflows.get('parent')!, 'outer__call')!;
    expect('with' in call ? call.with : undefined).toEqual({
      payload: '$outer__local.output',
      style: 'strict',
    });
  });

  test('reports a missing required input referenced only from a with: value', () => {
    const block = withSignature(
      wf('caller-blk', [{ id: 'call', workflow: 'child', with: { diff: '$INPUTS.diff' } }]),
      { inputs: { diff: { required: true } } }
    );
    const parent = wf('parent', [{ id: 'outer', include: 'caller-blk' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain("requires input 'diff'");
  });
});

// ---------------------------------------------------------------------------
// Composed-node metadata (#1764) — the engine-private stamp that carries a
// node's authoring workflow, its resolved inputs, and its block-entry position.
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — composed-node metadata survives nesting', () => {
  test('a node stamped at the INNER level keeps that stamp two levels out', () => {
    // inner declares `plan`; mid forwards its own `topic` into it; top supplies `topic`.
    // `mid__blk__run` is cloned TWICE (inner→mid, then mid→top). structuredClone drops
    // symbol keys, so without explicit preservation the stamp vanishes at the second
    // clone and the composed script silently sees no INPUTS_PLAN.
    const inner = withSignature(wf('inner', [{ id: 'run', bash: 'echo run' }]), {
      inputs: { plan: { required: true } },
    });
    const mid = withSignature(
      wf('mid', [{ id: 'blk', include: 'inner', with: { plan: '$INPUTS.topic' } }]),
      { inputs: { topic: { required: true } } }
    );
    const top = wf('top', [{ id: 'mid', include: 'mid', with: { topic: 'ship it' } }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, mid, top));
    expect(errors).toHaveLength(0);

    const run = nodeById(workflows.get('top')!, 'mid__blk__run')!;
    // Write-once: the INNER workflow's own input name, not the outer's `topic`.
    expect(composedInputs(run)).toEqual({ plan: 'ship it' });
    expect(composedOrigin(run)).toBe('inner');
  });
});

describe('expandWorkflowIncludes — systemPrompt/agents are node-ref surfaces (#2476)', () => {
  test('namespaces $node.output refs in systemPrompt and every agents field', () => {
    const block = wf('blk', [
      { id: 'gather', bash: 'echo data' },
      {
        id: 'use',
        prompt: 'work',
        depends_on: ['gather'],
        systemPrompt: 'context: $gather.output',
        agents: {
          helper: { description: 'reads $gather.output', prompt: 'act on $gather.output' },
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    const use = nodeById(workflows.get('parent')!, 'inc__use')!;
    expect(use.systemPrompt).toBe('context: $inc__gather.output');
    expect(use.agents?.helper.description).toBe('reads $inc__gather.output');
    expect(use.agents?.helper.prompt).toBe('act on $inc__gather.output');
  });
});

describe('expandWorkflowIncludes — composed approval gates are stamped, not rejected (#1764)', () => {
  const gateBlock = (): WorkflowDefinition =>
    wf('gate-blk', [
      { id: 'plan', prompt: 'plan' },
      { id: 'gate', approval: { message: 'Approve?' }, depends_on: ['plan'] },
    ]);

  test('a composed gate carries its origin so invocation can decide', () => {
    // Expansion records WHERE the gate came from; whether a run can drive it is a
    // question only the invoked workflow can answer (see assertComposedGateDriveable).
    const parent = wf('parent', [{ id: 'inc', include: 'gate-blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(gateBlock(), parent));

    expect(errors).toHaveLength(0);
    expect(composedOrigin(nodeById(workflows.get('parent')!, 'inc__gate'))).toBe('gate-blk');
  });

  test('a non-interactive INTERMEDIATE block still expands — it is never the run owner', () => {
    // The regression this replaced: rejecting at every expansion level made a valid
    // three-level composition unloadable even when the top-level workflow declared
    // `interactive: true`, because the intermediate block has no reason to declare it.
    const mid = wf('mid', [{ id: 'i', include: 'gate-blk' }]);
    const top = { ...wf('top', [{ id: 'm', include: 'mid' }]), interactive: true };

    const { workflows, errors } = expandWorkflowIncludes(mapOf(gateBlock(), mid, top));
    expect(errors).toHaveLength(0);
    expect(workflows.has('top')).toBe(true);
    expect(workflows.has('mid')).toBe(true);
    // The stamp names the file that authored the gate, three levels down.
    expect(composedOrigin(nodeById(workflows.get('top')!, 'm__i__gate'))).toBe('gate-blk');
  });

  test("a parent's OWN approval node carries no composed origin", () => {
    // One file, one reader: the gate and the missing `interactive:` are visible together,
    // so invocation has nothing to refuse.
    const plain = wf('plain-blk', [{ id: 'work', prompt: 'work' }]);
    const parent = wf('parent', [
      { id: 'inc', include: 'plain-blk' },
      { id: 'gate', approval: { message: 'Approve?' }, depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(plain, parent));
    expect(errors).toHaveLength(0);
    expect(composedOrigin(nodeById(workflows.get('parent')!, 'gate'))).toBeUndefined();
  });

  test('a composed gate nested inside a loop_group body is stamped too', () => {
    const block = wf('lg-gate-blk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [{ id: 'gate', approval: { message: 'Approve?' } }],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'lg-gate-blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'inc__group') as {
      loop_group: { nodes: DagNode[] };
    };
    expect(composedOrigin(group.loop_group.nodes[0])).toBe('lg-gate-blk');
  });
});

describe('expandWorkflowIncludes — requires: unions instead of dropping (#1764)', () => {
  test("a composed block's requirement reaches the composing workflow, de-duplicated", () => {
    const inner = { ...wf('inner', [{ id: 'a', prompt: 'a' }]), requires: ['github' as const] };
    const mid = { ...wf('mid', [{ id: 'i', include: 'inner' }]), requires: ['github' as const] };
    const top = wf('top', [{ id: 'm', include: 'mid' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, mid, top));
    expect(errors).toHaveLength(0);
    expect(workflows.get('top')!.requires).toEqual(['github']);
    expect(workflows.get('mid')!.requires).toEqual(['github']);
  });

  test('a workflow composing nothing that requires anything keeps requires undefined', () => {
    const block = wf('plain', [{ id: 'a', prompt: 'a' }]);
    const parent = wf('parent', [{ id: 'inc', include: 'plain' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.get('parent')!.requires).toBeUndefined();
  });
});

describe('expandWorkflowIncludes — where a workflow-level model: travels (#1764)', () => {
  const collapse = (w: WorkflowDefinition): DagNode[] =>
    expandWorkflowIncludes(mapOf(w)).workflows.get(w.name)!.nodes;

  test('travels to a node that declares no provider of its own', () => {
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p' }]),
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(nodes[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' });
  });

  test('travels to a node that redundantly re-declares the SAME provider', () => {
    // The branch a regression would most plausibly drop, and a common authoring habit.
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'codex' }]),
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(nodes[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' });
  });

  test('does NOT travel to a node that switches provider', () => {
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'claude' }]),
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect((nodes[0] as Record<string, unknown>).model).toBeUndefined();
  });

  test('does NOT travel when the workflow declares a model but no provider — the known divergence', () => {
    // Pinned deliberately: the pre-collapse chain compared the node against the RESOLVED
    // workflow provider, so a tier resolving to `codex` DID reach a `provider: codex`
    // node. Load time cannot resolve tiers (they depend on the acting user's prefs), so
    // the model stays behind and the node uses its own provider's configured default.
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'codex' }]),
      model: 'large',
    });
    expect((nodes[0] as Record<string, unknown>).model).toBeUndefined();
    expect((nodes[0] as Record<string, unknown>).provider).toBe('codex');
  });

  test('every other node-affecting field travels regardless of the node provider', () => {
    // `model` alone carries a provider condition, because it alone is a provider-specific
    // string the executor already refused to inherit across providers. `effort`/`thinking`/
    // `sandbox`/`betas`/`fallbackModel` had no such condition before the collapse and must
    // not gain one, or the collapse stops being behaviour-preserving.
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'claude' }]),
      provider: 'codex',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 4000 },
      sandbox: { enabled: true },
      betas: ['beta-x'],
      fallbackModel: 'fallback-1',
    });
    expect(nodes[0]).toMatchObject({
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 4000 },
      sandbox: { enabled: true },
      betas: ['beta-x'],
      fallbackModel: 'fallback-1',
    });
  });
});
