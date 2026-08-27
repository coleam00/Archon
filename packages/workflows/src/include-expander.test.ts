import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes, INCLUDE_MAX_DEPTH } from './include-expander';
import { dagNodeSchema } from './schemas';
import type { WorkflowDefinition, DagNode } from './schemas';
import { COMPOSE_FAN_OUT_STEP_MARKER } from './fan-out-identity';
import {
  COMPILED_LOOP_COMMAND,
  COMPOSED_NODE,
  type ComposedBlockBoundary,
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
  // Callers always pass an expandWorkflowIncludes() result, which never contains
  // an IncludeDirective (#2486).
  return (w.nodes as DagNode[]).find(n => n.id === id);
}

function composedMeta(node: DagNode | undefined): ComposedNodeMeta | undefined {
  return node === undefined ? undefined : (node as DagNode & NodeWithComposedMeta)[COMPOSED_NODE];
}

function composedInputs(node: DagNode | undefined): Record<string, unknown> | undefined {
  return composedMeta(node)?.inputs;
}

function composedOrigin(node: DagNode | undefined): string | undefined {
  return composedMeta(node)?.origin;
}

function composedBoundaries(node: DagNode | undefined): ComposedBlockBoundary[] | undefined {
  return composedMeta(node)?.boundaries;
}

function compiledLoopPrompt(node: DagNode | undefined): string | undefined {
  if (!node || !('loop' in node)) return undefined;
  return (node.loop as typeof node.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]?.prompt;
}

/** The `loop_group` config of a loop_group node, or undefined for any other kind. */
function loopGroupOf(
  node: DagNode | undefined
): { nodes: DagNode[]; until_bash?: string } | undefined {
  if (!node || !('loop_group' in node)) return undefined;
  return { ...node.loop_group, nodes: node.loop_group.nodes as DagNode[] };
}

/** The body nodes of a `loop_group` node, or undefined for any other kind. */
function loopGroupNodes(node: DagNode | undefined): DagNode[] | undefined {
  return loopGroupOf(node)?.nodes;
}

/** The inline prompt text of an agent node, or undefined for any other kind
 * or a command-sourced agent node (formerly the bare `'prompt' in node` idiom, #2486). */
function inlinePrompt(node: DagNode | undefined): string | undefined {
  return node && 'source' in node && node.source.kind === 'inline' ? node.source.prompt : undefined;
}

/** The shell script text of a `runtime: 'sh'` exec node, or undefined for any other
 * kind (formerly the bare `'bash' in node` idiom, #2486). */
function bashScript(node: DagNode | undefined): string | undefined {
  return node && 'script' in node && node.runtime === 'sh' ? node.script : undefined;
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

describe('expandWorkflowIncludes — composed fan-out deferral (#2512)', () => {
  test('leaves an include+fan_out node unexpanded but validates the target exists', () => {
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      // items must reference an upstream producer now that the loader scans a
      // compose_fan_out's fan_out.items like a workflow node's.
      {
        id: 'fan',
        include: 'blk',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('parent')!;
    expect(expanded.nodes).toHaveLength(2);
    const deferred = expanded.nodes.find(n => n.id === 'fan');
    expect(deferred).toMatchObject({ kind: 'compose_fan_out', include: 'blk' });
  });

  test('errors at load time when the fan-out target name does not resolve', () => {
    const parent = wf('parent', [
      {
        id: 'fan',
        include: 'no-such-block',
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(parent));
    expect(workflows.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Node 'fan'");
    expect(errors[0]?.error).toContain("'no-such-block' not found");
  });

  test('validates required inputs and the item binding through ordinary include expansion', () => {
    const block = {
      ...wf('typed-block', [{ id: 'work', prompt: '$INPUTS.file $INPUTS.mode' }]),
      inputs: { file: { required: true }, mode: { required: true } },
    };
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'typed-block',
        depends_on: ['list'],
        with: { mode: 'strict' },
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "does not declare input 'item'"
    );
  });

  test('rejects a missing non-item required input before runtime', () => {
    const block = {
      ...wf('typed-block', [{ id: 'work', prompt: '$INPUTS.item $INPUTS.mode' }]),
      inputs: { item: { required: true }, mode: { required: true } },
    };
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'typed-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "requires input 'mode'"
    );
  });

  test('materializes packaged command resources for a deferred block at load time', () => {
    const block = wf('command-block', [{ id: 'work', command: 'missing-command' }]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'command-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "command 'missing-command'"
    );
  });

  test.each([
    ['approval gate', { id: 'pause', approval: { message: 'Continue?' } }],
    ['durable wait', { id: 'pause', wait: { duration_ms: 3_600_000 } }],
    [
      'interactive loop',
      {
        id: 'pause',
        loop: {
          prompt: 'iterate',
          until: 'DONE',
          max_iterations: 2,
          interactive: true,
          gate_message: 'Continue?',
        },
      },
    ],
    [
      'interactive loop group',
      {
        id: 'pause',
        loop_group: {
          nodes: [{ id: 'work', bash: 'echo work' }],
          until_bash: 'exit 1',
          max_iterations: 2,
          interactive: true,
          gate_message: 'Continue?',
        },
      },
    ],
  ])('rejects a %s in the composed closure at load time', (_label, pausingNode) => {
    const block = wf('pausing-block', [pausingNode]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'pausing-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      'unsupported suspension-capable path'
    );
  });

  test('rejects a pause-capable nested workflow target at load time', () => {
    const child = {
      ...wf('child', [{ id: 'pause', wait: { duration_ms: 3_600_000 } }]),
      interactive: true,
    };
    const block = wf('workflow-block', [{ id: 'child-run', workflow: 'child' }]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'workflow-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(child, block, parent));

    expect(workflows.has('parent')).toBe(false);
    const error = errors.find(entry => entry.filename === 'parent')?.error;
    expect(error).toContain("'child' (interactive workflow)");
    expect(error).toContain("'pause' (durable wait)");
  });

  test("rewrites $node.output refs in the deferred node's with values and items ref", () => {
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      { id: 'blk1', include: 'blk', depends_on: ['list'] },
      {
        id: 'fan',
        include: 'blk',
        depends_on: ['list', 'blk1'],
        with: { seed: '$blk1.output' },
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);
    const deferred = workflows.get('parent')!.nodes.find(n => n.id === 'fan') as unknown as {
      with?: Record<string, string>;
      fan_out: { items: string };
    };
    expect(deferred.with?.seed).toBe('$blk1__impl.output');
    expect(deferred.fan_out.items).toBe('$list.output');
  });
});

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

  test('rewrites named session sources through nested include namespaces', () => {
    const leaf = wf('leaf-lineage', [
      { id: 'source', prompt: 'scope' },
      {
        id: 'consumer',
        prompt: 'continue',
        depends_on: ['source'],
        context: { resume: 'source' },
      },
    ]);
    const middle = wf('middle-lineage', [{ id: 'inner', include: 'leaf-lineage' }]);
    const parent = wf('parent-lineage', [{ id: 'outer', include: 'middle-lineage' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent-lineage')!;
    const consumer = nodeById(expanded, 'outer__inner__consumer');
    expect(consumer?.context).toEqual({ resume: 'outer__inner__source' });
    expect(consumer?.depends_on).toEqual(['outer__inner__source']);
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
    expect(inlinePrompt(summary) ?? '').toBe('read $review__impl.output here');
    // Internal block ref ($verify.output inside scope) namespaced too.
    const scope = nodeById(expanded, 'review__scope');
    expect(inlinePrompt(scope) ?? '').toBe('scope $review__verify.output');
  });

  test('rewrites node refs and inputs in wait conditions', () => {
    const block = wf('waiting-block', [
      { id: 'schedule', bash: 'echo 2026-08-25T22:00:00Z' },
      {
        id: 'wait-for-window',
        wait: { until: '$schedule.output' },
        depends_on: ['schedule'],
      },
      {
        id: 'wait-for-event',
        wait: { event: '$INPUTS.event', deadline_ms: 60_000 },
        depends_on: ['wait-for-window'],
      },
      {
        id: 'wait-for-input-time',
        wait: { until: '$INPUTS.resume_at' },
        depends_on: ['wait-for-event'],
      },
    ]);
    block.inputs = { event: { required: true }, resume_at: { required: true } };
    const parent = wf('parent', [
      {
        id: 'waiting',
        include: 'waiting-block',
        with: { event: 'checks.complete', resume_at: '2026-08-25T23:00:00Z' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    const untilNode = nodeById(expanded, 'waiting__wait-for-window');
    const eventNode = nodeById(expanded, 'waiting__wait-for-event');
    const inputTimeNode = nodeById(expanded, 'waiting__wait-for-input-time');
    expect(
      untilNode && 'wait' in untilNode && 'until' in untilNode.wait
        ? untilNode.wait.until
        : undefined
    ).toBe('$waiting__schedule.output');
    expect(
      eventNode && 'wait' in eventNode && 'event' in eventNode.wait
        ? eventNode.wait.event
        : undefined
    ).toBe('checks.complete');
    expect(
      inputTimeNode && 'wait' in inputTimeNode && 'until' in inputTimeNode.wait
        ? inputTimeNode.wait.until
        : undefined
    ).toBe('2026-08-25T23:00:00Z');
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

  test('boundary dependency edges fan out to every sink while scalar refs use the primary sink', () => {
    const upstream = wf('upstream', [
      { id: 'primary', bash: 'echo primary' },
      { id: 'secondary', bash: 'echo secondary' },
    ]);
    const downstream = wf('downstream', [
      { id: 'entry', bash: 'echo entry', trigger_rule: 'one_success' },
      { id: 'join', bash: 'echo join', depends_on: ['entry'], trigger_rule: 'all_done' },
    ]);
    const parent = wf('parent', [
      { id: 'up', include: 'upstream' },
      {
        id: 'down',
        include: 'downstream',
        depends_on: ['up'],
        when: "$up.output == 'primary'",
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(upstream, downstream, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;

    expect(nodeById(expanded, 'down__entry')?.depends_on).toEqual(['up__primary', 'up__secondary']);
    expect(composedBoundaries(nodeById(expanded, 'down__join'))).toEqual([
      {
        dependsOn: ['up__primary', 'up__secondary'],
        entryTriggerRules: ['one_success'],
        when: "$up__primary.output == 'primary'",
        isEntry: false,
      },
    ]);
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
    expect(inlinePrompt(judge) ?? '').toBe(
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
      source: { kind: 'inline', prompt: 'Main: CLEAN-TEMP-FILES' },
      systemPrompt: 'You handle CLEAN-TEMP-FILES',
      agents: {
        helper: {
          description: 'Handles CLEAN-TEMP-FILES',
          prompt: 'Sub-task: CLEAN-TEMP-FILES',
        },
      },
    });
    expect(nodeById(expanded, 'review__gate')).toMatchObject({
      message: 'Approve CLEAN-TEMP-FILES?',
      decisions: [
        { id: 'approve' },
        { id: 'reject', rework: { prompt: 'Retry with CLEAN-TEMP-FILES' } },
      ],
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
    expect(inlinePrompt(use) ?? '').toBe('v=literal-value');
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
    expect(inlinePrompt(first) ?? '').toBe('Use alpha');
    expect(inlinePrompt(second) ?? '').toBe('Use beta');
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
    expect(inlinePrompt(use) ?? '').toBe('Parent: $gather.output; child: $review__gather.output');
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
    expect(inlinePrompt(use) ?? '').toBe('Leaf: $plan.output');
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
    expect(inlinePrompt(use) ?? '').toBe('```\nliteral literal\n``` empty=[]');
  });

  test('rejects a when expression made unparseable by input substitution', () => {
    const block = wf('parameterized', [
      { id: 'probe', bash: 'echo go' },
      {
        id: 'use',
        prompt: 'work',
        depends_on: ['probe'],
        when: "$INPUTS.mode == 'fast' && $probe.output == 'go'",
      },
    ]);
    block.inputs = { mode: { default: 'fast' } };
    const parent = wf('parent', [{ id: 'review', include: 'parameterized' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    const error = errors.find(candidate => candidate.filename === 'parent')?.error;
    expect(error).toContain("Node 'review'");
    expect(error).toContain("$INPUTS.mode == 'fast' && $review__probe.output == 'go'");
    expect(error).toContain("fast == 'fast' && $review__probe.output == 'go'");
    expect(error).toContain('right-hand side');
  });

  test('does not broaden the load error to an unchanged malformed when expression', () => {
    const block = wf('parameterized', [{ id: 'use', prompt: 'work', when: 'not an atom' }]);
    block.inputs = { mode: { default: 'fast' } };
    const parent = wf('parent', [{ id: 'review', include: 'parameterized' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'review__use')?.when).toBe('not an atom');
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
    expect(nodeById(expanded, 'review__shell')).toMatchObject({
      script: 'echo done',
      runtime: 'sh',
    });
    expect(nodeById(expanded, 'review__script')).toMatchObject({ script: 'console.log("done")' });
    expect(loop).toMatchObject({
      loop: { prompt: 'Do done', until_bash: 'test "done" = done' },
    });
    expect(approval).toMatchObject({ message: 'Approve done?' });
    expect(nodeById(expanded, 'review__cancel')).toMatchObject({ reason: 'Stop: done' });
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
        nodes: [{ id: 'body', script: 'echo done', runtime: 'sh' }],
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
    const repeat = loopGroupNodes(group)?.[0];
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
    const prompt = inlinePrompt(writer) ?? '';
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
    expect(bashScript(b) ?? '').toBe('echo $inc__a.output');
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
    expect(gate && 'message' in gate ? gate.message : '').toBe('Approve $inc__plan.output');
    expect(
      (gate && 'decisions' in gate
        ? gate.decisions.find(d => d.id === 'reject')?.rework?.prompt
        : undefined) ?? ''
    ).toBe('Revise $inc__plan.output');
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
    expect(inlinePrompt(runner) ?? '').toBe(
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
    expect(inlinePrompt(runner) ?? '').toBe('Review scope prod.');
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
    expect(inlinePrompt(runner) ?? '').toBe('Review bound value.');
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
    expect(inlinePrompt(runner) ?? '').toBe('Review $gather.output.');
  });

  test('treats canonical refs inside Markdown code as live and namespaces them', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Work from $ARTIFACTS_DIR only. See `$sib.output` in fenced docs.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toContain('`$inc__sib.output`');
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
    expect(inlinePrompt(runner) ?? '').toContain('echo "prod"');
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
    const repeat = loopGroupNodes(group)?.[0];
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
    const inner = loopGroupNodes(outer)?.[0];
    const review = loopGroupNodes(inner)?.[0];
    expect(inlinePrompt(review) ?? '').toBe('Read $inc__seed.output and continue.');
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
    const repeat = loopGroupNodes(group)?.[0];
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
    const lg = nodeById(expanded, 'rev__lg');
    const body = loopGroupNodes(lg)?.[0];
    // Body node id is NOT renamed (body-local), so its $LOOP_PREV.<bodyId> ref is preserved,
    // while the outer-sibling ref ($seed.output) IS rewritten to the namespaced id.
    expect(body?.id).toBe('inner');
    expect(inlinePrompt(body)).toBe('prev=$LOOP_PREV.inner.output outer=$rev__seed.output');
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

  test('reserves the engine-owned composed fan-out namespace from authored ids', () => {
    const block = wf('blk', [{ id: 'work', bash: 'echo work' }]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'blk',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
      { id: `authored${COMPOSE_FAN_OUT_STEP_MARKER}collision`, bash: 'echo collision' },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      `reserved engine namespace '${COMPOSE_FAN_OUT_STEP_MARKER}'`
    );
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
    expect(nodeById(expanded, 'b')?.model).toBeUndefined();
    // The input is never mutated — discovery hands the same object to display surfaces.
    expect(plain.provider).toBe('pi');
  });
});

// ---------------------------------------------------------------------------
// Includes inside loop_group bodies (#2623)
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — loop_group body composition (#2623)', () => {
  test('expands a body include in local scope and binds completion to its declared return', () => {
    const block: WorkflowDefinition = {
      ...wf('review-block', [
        {
          id: 'decide',
          prompt: 'review $INPUTS.context',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
        },
        {
          id: 'cleanup',
          bash: 'echo $LOOP_PREV.decide.output.done',
          depends_on: ['decide'],
        },
      ]),
      inputs: { context: { required: true } },
      returns: 'decide',
      requires: ['github'],
    };
    const parent = wf('parent', [
      {
        id: 'group',
        loop_group: {
          until_bash: 'test "$review.output.done" = true',
          max_iterations: 3,
          nodes: [
            { id: 'seed', bash: 'echo context' },
            {
              id: 'review',
              include: 'review-block',
              depends_on: ['seed'],
              with: { context: '$seed.output' },
            },
            {
              id: 'consume',
              prompt: 'done=$review.output.done previous=$LOOP_PREV.review.output',
              depends_on: ['review'],
            },
          ],
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    const group = nodeById(expanded, 'group');
    const groupConfig = loopGroupOf(group);
    expect(groupConfig?.nodes.map(node => node.id)).toEqual([
      'seed',
      'review__decide',
      'review__cleanup',
      'consume',
    ]);
    expect(groupConfig?.nodes.some(node => 'include' in node)).toBe(false);
    expect(groupConfig?.until_bash).toBe('test "$review__decide.output.done" = true');

    const decide = groupConfig?.nodes.find(node => node.id === 'review__decide');
    const cleanup = groupConfig?.nodes.find(node => node.id === 'review__cleanup');
    const consume = groupConfig?.nodes.find(node => node.id === 'consume');
    expect(decide?.depends_on).toEqual(['seed']);
    expect(cleanup?.depends_on).toEqual(['review__decide']);
    expect(bashScript(cleanup) ?? '').toBe('echo $LOOP_PREV.review__decide.output.done');
    expect(consume?.depends_on).toEqual(['review__cleanup']);
    expect(inlinePrompt(consume) ?? '').toBe(
      'done=$review__decide.output.done previous=$LOOP_PREV.review.output'
    );
    expect(inlinePrompt(decide) ?? '').toBe('review $seed.output');
    expect(composedOrigin(decide)).toBe('review-block');
    expect(composedInputs(decide)).toEqual({ context: '$seed.output' });
    expect(expanded.requires).toEqual(['github']);
  });

  test('expands independent includes in nested loop_group scopes without leaking directives', () => {
    const block = wf('block', [{ id: 'work', prompt: 'work' }]);
    const parent = wf('parent', [
      {
        id: 'outer',
        loop_group: {
          until_bash: 'true',
          max_iterations: 1,
          nodes: [
            { id: 'first', include: 'block' },
            { id: 'second', include: 'block', depends_on: ['first'] },
            {
              id: 'inner',
              loop_group: {
                until_bash: 'test -n "$third.output"',
                max_iterations: 1,
                nodes: [{ id: 'third', include: 'block' }],
              },
              depends_on: ['second'],
            },
          ],
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    const outer = nodeById(workflows.get('parent')!, 'outer');
    const outerConfig = loopGroupOf(outer);
    expect(outerConfig?.nodes.map(node => node.id)).toEqual([
      'first__work',
      'second__work',
      'inner',
    ]);
    expect(outerConfig?.nodes.find(node => node.id === 'second__work')?.depends_on).toEqual([
      'first__work',
    ]);
    const inner = outerConfig?.nodes.find(node => node.id === 'inner');
    const innerConfig = loopGroupOf(inner);
    expect(innerConfig?.nodes.map(node => node.id)).toEqual(['third__work']);
    expect(innerConfig?.until_bash).toBe('test -n "$third__work.output"');
  });

  test('fails the owning workflow when a body include target is unknown', () => {
    const parent = wf('parent', [
      {
        id: 'group',
        loop_group: {
          until_bash: 'true',
          max_iterations: 1,
          nodes: [{ id: 'missing', include: 'does-not-exist' }],
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "Node 'missing': include target 'does-not-exist' not found"
    );
  });
});

// ---------------------------------------------------------------------------
// returns: + declared inputs: (#2470)
// ---------------------------------------------------------------------------

/** Add workflow-level signature fields to a block. */
function withSignature(
  base: WorkflowDefinition,
  sig: {
    returns?: string;
    outcome_field?: string;
    inputs?: WorkflowDefinition['inputs'];
  }
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
    expect(inlinePrompt(consume) ?? '').toBe('result: $blk__synthesize.output');
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
    expect(inlinePrompt(consume) ?? '').toBe('value: $outer__blk__result.output');
  });

  test('validates an outer outcome_field against the rebound flattened return node', () => {
    const resultNode = {
      id: 'result',
      prompt: 'result',
      output_format: {
        type: 'object',
        properties: { green: { type: 'boolean' } },
        required: ['green'],
      },
    };
    const inner = withSignature(wf('inner', [resultNode]), { returns: 'result' });
    const outer = withSignature(wf('outer', [{ id: 'blk', include: 'inner' }]), {
      returns: 'blk',
      outcome_field: 'green',
    });

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, outer));

    expect(errors).toHaveLength(0);
    expect(workflows.get('outer')).toMatchObject({
      returns: 'blk__result',
      outcome_field: 'green',
    });
  });

  test('rejects an outer outcome_field after return rebinding when the child contract is invalid', () => {
    const inner = withSignature(
      wf('inner', [
        {
          id: 'result',
          prompt: 'result',
          output_format: {
            type: 'object',
            properties: { green: { type: 'string' } },
            required: ['green'],
          },
        },
      ]),
      { returns: 'result' }
    );
    const outer = withSignature(wf('outer', [{ id: 'blk', include: 'inner' }]), {
      returns: 'blk',
      outcome_field: 'green',
    });

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, outer));

    expect(workflows.has('outer')).toBe(false);
    expect(errors.find(error => error.filename === 'outer')?.error).toContain(
      'must explicitly declare type: boolean'
    );
  });

  test('keeps a nested outer declaration but never propagates an included workflow outcome', () => {
    const leaf = withSignature(
      wf('leaf', [
        {
          id: 'result',
          prompt: 'result',
          output_format: {
            type: 'object',
            properties: { green: { type: 'boolean' } },
            required: ['green'],
          },
        },
      ]),
      { returns: 'result', outcome_field: 'green' }
    );
    const middle = withSignature(wf('middle', [{ id: 'leaf-block', include: 'leaf' }]), {
      returns: 'leaf-block',
    });
    const outer = withSignature(wf('outer', [{ id: 'middle-block', include: 'middle' }]), {
      returns: 'middle-block',
      outcome_field: 'green',
    });

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, outer));

    expect(errors).toHaveLength(0);
    expect(workflows.get('middle')?.outcome_field).toBeUndefined();
    expect(workflows.get('outer')).toMatchObject({
      returns: 'middle-block__leaf-block__result',
      outcome_field: 'green',
    });
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
    expect(inlinePrompt(work) ?? '').toBe('style: strict');
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
    expect(inlinePrompt(work) ?? '').toBe('v: hello');
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

  test('repeated includes keep distinct caller boundaries', () => {
    const block = wf('gated-block', [
      { id: 'entry', bash: 'echo entry', trigger_rule: 'all_done' },
      { id: 'done', bash: 'echo done', depends_on: ['entry'], trigger_rule: 'all_done' },
    ]);
    const parent = wf('parent', [
      { id: 'gate-a', bash: 'echo A' },
      { id: 'gate-b', bash: 'echo B' },
      {
        id: 'first',
        include: 'gated-block',
        depends_on: ['gate-a'],
        when: "$gate-a.output == 'A'",
        trigger_rule: 'one_success',
      },
      {
        id: 'second',
        include: 'gated-block',
        depends_on: ['gate-b'],
        when: "$gate-b.output == 'B'",
        trigger_rule: 'one_success',
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    expect(composedBoundaries(nodeById(workflows.get('parent')!, 'first__done'))).toEqual([
      {
        dependsOn: ['gate-a'],
        entryTriggerRules: ['all_done'],
        when: "$gate-a.output == 'A'",
        isEntry: false,
      },
    ]);
    expect(composedBoundaries(nodeById(workflows.get('parent')!, 'second__done'))).toEqual([
      {
        dependsOn: ['gate-b'],
        entryTriggerRules: ['all_done'],
        when: "$gate-b.output == 'B'",
        isEntry: false,
      },
    ]);
  });

  test('nested include boundaries retain their own namespaced predicates', () => {
    const leaf = wf('leaf', [{ id: 'work', bash: 'echo work' }]);
    const middle = withSignature(
      wf('middle', [
        { id: 'local-gate', bash: 'echo local' },
        {
          id: 'inner',
          include: 'leaf',
          depends_on: ['local-gate'],
          when: "$local-gate.output == '$INPUTS.expected'",
        },
      ]),
      { inputs: { expected: { required: true } } }
    );
    const top = wf('top', [
      { id: 'outer-gate', bash: 'echo outer' },
      {
        id: 'outer',
        include: 'middle',
        depends_on: ['outer-gate'],
        when: "$outer-gate.output == 'outer'",
        with: { expected: 'local' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, top));
    expect(errors).toHaveLength(0);
    expect(composedBoundaries(nodeById(workflows.get('top')!, 'outer__inner__work'))).toEqual([
      {
        dependsOn: ['outer-gate'],
        entryTriggerRules: ['all_success'],
        when: "$outer-gate.output == 'outer'",
        isEntry: false,
      },
      {
        dependsOn: ['outer__local-gate'],
        entryTriggerRules: ['all_success'],
        when: "$outer__local-gate.output == 'local'",
        isEntry: true,
        entryTriggerRule: 'all_success',
      },
    ]);
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
    expandWorkflowIncludes(mapOf(w)).workflows.get(w.name)!.nodes as DagNode[];

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
    expect(nodes).toHaveLength(1);
    expect(nodes[0].model).toBeUndefined();
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
    expect(nodes[0]?.model).toBeUndefined();
    expect(nodes[0]?.provider).toBe('codex');
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

// ---------------------------------------------------------------------------
// #2637 — JSON-valued include inputs: literals splice as canonical text into
// text surfaces, while whole-`$INPUTS.<name>` value positions forward the
// LOGICAL value (a boolean stays a boolean through nested composition).
// ---------------------------------------------------------------------------

describe('expandWorkflowIncludes — typed with: values (#2637)', () => {
  test('typed literals splice as canonical text into prompt and bash surfaces', () => {
    const block = wf('typed-blk', [
      { id: 'think', prompt: 'flag=$INPUTS.flag items=$INPUTS.items' },
      { id: 'run', bash: 'echo "n=$INPUTS.count"', depends_on: ['think'] },
    ]);
    const parent = wf('parent', [
      { id: 'use', include: 'typed-blk', with: { flag: true, items: ['a', 'b'], count: 3 } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const think = nodeById(workflows.get('parent')!, 'use__think');
    expect(inlinePrompt(think) ?? '').toBe('flag=true items=["a","b"]');
    const run = nodeById(workflows.get('parent')!, 'use__run');
    expect(bashScript(run) ?? '').toBe('echo "n=3"');
  });

  test('a whole-$INPUTS with: value position forwards the LOGICAL value; templates splice text', () => {
    const block = withSignature(
      wf('fwd-blk', [
        {
          id: 'call',
          workflow: 'child',
          with: { x: '$INPUTS.flag', label: 'v=$INPUTS.flag' },
        },
      ]),
      { inputs: { flag: {} } }
    );
    const parent = wf('parent', [{ id: 'outer', include: 'fwd-blk', with: { flag: true } }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const call = nodeById(workflows.get('parent')!, 'outer__call')!;
    expect('with' in call ? call.with : undefined).toEqual({ x: true, label: 'v=true' });
  });

  test('the composed-node stamp keeps typed inputs logical for shell env delivery', () => {
    const block = withSignature(wf('stamp-blk', [{ id: 'run', bash: 'echo hi' }]), {
      inputs: { flag: {}, note: {} },
    });
    const parent = wf('parent', [
      { id: 'use', include: 'stamp-blk', with: { flag: false, note: 'text' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const run = nodeById(workflows.get('parent')!, 'use__run');
    expect(composedInputs(run)).toEqual({ flag: false, note: 'text' });
  });

  test('command/script node-local bindings are walked: refs namespaced, $INPUTS resolved', () => {
    const block = withSignature(
      wf('bind-blk', [
        { id: 'gather', bash: 'echo data' },
        {
          id: 'consume',
          script: 'console.log("x")',
          runtime: 'bun',
          depends_on: ['gather'],
          with: {
            data: '$gather.output',
            mode: '$INPUTS.mode',
            guarded: { from: '$gather.output.field', if_skipped: '$INPUTS.mode' },
          },
        },
      ]),
      { inputs: { mode: {} } }
    );
    const parent = wf('parent', [{ id: 'use', include: 'bind-blk', with: { mode: true } }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const consume = nodeById(workflows.get('parent')!, 'use__consume')!;
    expect('with' in consume ? consume.with : undefined).toEqual({
      data: '$use__gather.output',
      mode: true,
      guarded: { from: '$use__gather.output.field', if_skipped: true },
    });
  });

  test('an object forwarded into a command/script binding position fails the expansion, never mid-run', () => {
    // The schema promises a load error for a non-directive object on these maps, and
    // only substitution can smuggle one past it: the block's string is valid at its
    // own parse, then the caller supplies an object for the input. Re-validate after
    // the macro (the substituteWhen precedent) so the workflow never lists clean and
    // then fails at the node after upstream cost.
    const block = withSignature(
      wf('bind-obj-blk', [
        {
          id: 'consume',
          script: 'console.log("x")',
          runtime: 'bun',
          with: { mode: '$INPUTS.mode' },
        },
      ]),
      { inputs: { mode: {} } }
    );
    const parent = wf('parent', [
      { id: 'use', include: 'bind-obj-blk', with: { mode: { nested: 'object' } } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(e => e.filename === 'parent')?.error;
    expect(message).toContain("binding 'mode'");
    expect(message).toContain('OBJECT');

    // A directive-SHAPED caller object is rejected the same way — data must not be
    // able to inject reference semantics the block never authored.
    const sneaky = wf('parent', [
      { id: 'use', include: 'bind-obj-blk', with: { mode: { from: '$use__consume.output' } } },
    ]);
    const second = expandWorkflowIncludes(mapOf(block, sneaky));
    expect(second.workflows.has('parent')).toBe(false);
    expect(second.errors.find(e => e.filename === 'parent')?.error).toContain("binding 'mode'");
  });
});
