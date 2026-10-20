import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { wf, mapOf, nodeById, composedInputs, inlinePrompt } from './include-expander.fixtures';

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
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { detail: 'CLEAN-TEMP-FILES' } },
    ]);

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

  test('rejects an unchanged malformed when expression', () => {
    const block = wf('parameterized', [{ id: 'use', prompt: 'work', when: 'not an atom' }]);
    block.inputs = { mode: { default: 'fast' } };
    const parent = wf('parent', [{ id: 'review', include: 'parameterized' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.some(error => error.error.includes('unsupported condition syntax'))).toBe(true);
  });

  test('substitutes inputs across every other supported inline node surface', () => {
    const block = wf('parameterized', [
      { id: 'shell', bash: 'echo $INPUTS.value' },
      {
        id: 'loop',
        loop: {
          prompt: 'Do $INPUTS.value',
          until: 'DONE',
          max_iterations: 1,
          until_bash: 'test $INPUTS.value = done',
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
          until_bash: 'test $INPUTS.value = done',
          nodes: [{ id: 'body', bash: 'echo $INPUTS.value' }],
        },
      },
    ]);
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { value: 'done' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    const loop = nodeById(expanded, 'review__loop');
    const approval = nodeById(expanded, 'review__approval');
    const group = nodeById(expanded, 'review__group');
    // Shell slots read the value from the env the executor delivers, never as source.
    expect(nodeById(expanded, 'review__shell')).toMatchObject({
      script: 'echo "${INPUTS_VALUE}"',
      runtime: 'sh',
    });
    expect(loop).toMatchObject({
      loop: { prompt: 'Do done', until_bash: 'test "${INPUTS_VALUE}" = done' },
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
        until_bash: 'test "${INPUTS_VALUE}" = done',
        nodes: [{ id: 'body', script: 'echo "${INPUTS_VALUE}"', runtime: 'sh' }],
      },
    });
  });

  test('a shell macro the author already quoted is not unquoted', () => {
    // The expansion carries its own quotes and the expander does not parse shell, so
    // `"$INPUTS.value"` leaves the reference unquoted between two empty strings. The
    // guide tells authors to write the macro bare.
    const block = wf('quoted', [{ id: 'shell', bash: 'echo "$INPUTS.value"' }]);
    const parent = wf('parent', [{ id: 'inc', include: 'quoted', with: { value: 'a b' } }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'inc__shell')).toMatchObject({
      script: 'echo ""${INPUTS_VALUE}""',
    });
  });

  test('rejects the input macro in an inline script body and names the env var', () => {
    const block = wf('parameterized', [
      { id: 'script', runtime: 'bun', script: 'console.log("$INPUTS.base-branch")' },
    ]);
    const parent = wf('parent', [
      { id: 'review', include: 'parameterized', with: { 'base-branch': 'main' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    const error = errors.find(candidate => candidate.filename === 'parent')?.error;
    expect(error).toContain("included node 'script'");
    expect(error).toContain('$INPUTS.base-branch');
    expect(error).toContain('INPUTS_BASE_BRANCH');
  });
});

describe('expandWorkflowIncludes — with vs declared inputs (#2470)', () => {
  test('applies a declared default for an omitted input', () => {
    const block = wf('blk', [{ id: 'work', prompt: 'style: $INPUTS.style' }], {
      inputs: { style: { default: 'strict' } },
    });
    const parent = wf('parent', [{ id: 'blk', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const work = nodeById(workflows.get('parent')!, 'blk__work')!;
    expect(inlinePrompt(work) ?? '').toBe('style: strict');
  });

  test('errors on a missing required input', () => {
    const block = wf('blk', [{ id: 'work', prompt: 'diff: $INPUTS.diff' }], {
      inputs: { diff: { required: true } },
    });
    const parent = wf('parent', [{ id: 'blk', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain("requires input 'diff'");
  });

  test('errors on a caller with: key the block does not declare', () => {
    const block = wf('blk', [{ id: 'work', prompt: 'x' }], {
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
    const block = wf(
      'caller-blk',
      [
        { id: 'local', bash: 'echo hi' },
        {
          id: 'call',
          workflow: 'child',
          depends_on: ['local'],
          with: { payload: '$local.output', style: '$INPUTS.style' },
        },
      ],
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
});

describe('expandWorkflowIncludes — typed with: values (#2637)', () => {
  test('typed literals splice as canonical text into prompt surfaces', () => {
    const block = wf('typed-blk', [
      { id: 'think', prompt: 'flag=$INPUTS.flag items=$INPUTS.items' },
    ]);
    const parent = wf('parent', [
      { id: 'use', include: 'typed-blk', with: { flag: true, items: ['a', 'b'], count: 3 } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const think = nodeById(workflows.get('parent')!, 'use__think');
    expect(inlinePrompt(think) ?? '').toBe('flag=true items=["a","b"]');
  });

  test('a whole-$INPUTS with: value position forwards the LOGICAL value; templates splice text', () => {
    const block = wf(
      'fwd-blk',
      [
        {
          id: 'call',
          workflow: 'child',
          with: { x: '$INPUTS.flag', label: 'v=$INPUTS.flag' },
        },
      ],
      { inputs: { flag: {} } }
    );
    const parent = wf('parent', [{ id: 'outer', include: 'fwd-blk', with: { flag: true } }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const call = nodeById(workflows.get('parent')!, 'outer__call')!;
    expect('with' in call ? call.with : undefined).toEqual({ x: true, label: 'v=true' });
  });

  test('forwards a whole input object through a nested deferred fan-out with value', () => {
    const leaf = wf('leaf', [{ id: 'run', prompt: 'work' }]);
    const block = wf(
      'fan-block',
      [
        {
          id: 'fan',
          include: 'leaf',
          with: { config: '$INPUTS.config' },
          fan_out: { items: '["one"]', as: 'item' },
        },
      ],
      { inputs: { config: {} } }
    );
    const parent = wf('parent', [
      { id: 'use', include: 'fan-block', with: { config: { mode: 'strict' } } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, block, parent));
    expect(errors).toHaveLength(0);
    const fan = nodeById(workflows.get('parent')!, 'use__fan');
    expect(fan).toMatchObject({
      kind: 'compose_fan_out',
      with: { config: { mode: 'strict' } },
    });
  });

  test('the composed-node stamp keeps typed inputs logical for shell env delivery', () => {
    const block = wf('stamp-blk', [{ id: 'run', bash: 'echo hi' }], {
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
    const block = wf(
      'bind-blk',
      [
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
      ],
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
    const block = wf(
      'bind-obj-blk',
      [
        {
          id: 'consume',
          script: 'console.log("x")',
          runtime: 'bun',
          with: { mode: '$INPUTS.mode' },
        },
      ],
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
