// @archon-test-isolated
import { parseError, parseWorkflow } from './test-utils';
import { describe, it, expect } from 'bun:test';
import { evaluateCondition } from '../condition-evaluator';
import type { ParseResult } from '../loader';

describe('scalar shared session context', () => {
  function parseSessionContext(yaml: string): ParseResult {
    return parseWorkflow(yaml, 'session-context.yaml');
  }

  it('rejects scalar shared on a node in a structurally parallel layer', () => {
    const result = parseSessionContext(`
name: parallel-shared
description: parallel shared
nodes:
  - id: source
    prompt: source
  - id: shared
    prompt: continue
    depends_on: [source]
    context: shared
  - id: sibling
    prompt: independent
    depends_on: [source]
`);

    expect(result.error?.error).toContain(
      "Node 'shared' uses scalar context: 'shared' in a structurally parallel layer"
    );
    expect(result.error?.error).toContain('context: { resume: <upstream-node-id> }');
    expect(result.error?.error).toContain('depends_on');
  });

  it('rejects scalar shared when parallel sibling conditions appear mutually exclusive', () => {
    const result = parseSessionContext(`
name: conditional-parallel-shared
description: conditional parallel shared
nodes:
  - id: choice
    bash: echo left
  - id: left
    prompt: continue left
    depends_on: [choice]
    when: "$choice.output == 'left'"
    context: shared
  - id: right
    prompt: start right
    depends_on: [choice]
    when: "$choice.output == 'right'"
`);

    expect(result.error?.error).toContain(
      "Node 'left' uses scalar context: 'shared' in a structurally parallel layer"
    );
  });

  it('accepts scalar shared in a sequential chain', () => {
    const result = parseSessionContext(`
name: sequential-shared
description: sequential shared
nodes:
  - id: source
    prompt: source
  - id: continuation
    prompt: continue
    depends_on: [source]
    context: shared
`);

    expect(result.error).toBeNull();
  });

  it('accepts named resume in a structurally parallel layer', () => {
    const result = parseSessionContext(`
name: parallel-named-resume
description: parallel named resume
provider: claude
nodes:
  - id: source
    prompt: source
  - id: continuation
    prompt: continue
    depends_on: [source]
    context: { resume: source }
  - id: sibling
    prompt: independent
    depends_on: [source]
`);

    expect(result.error).toBeNull();
  });

  it('rejects scalar shared in a structurally parallel loop_group body', () => {
    const result = parseSessionContext(`
name: loop-group-parallel-shared
description: loop group parallel shared
nodes:
  - id: group
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: source
          prompt: source
        - id: shared
          prompt: continue
          depends_on: [source]
          context: shared
        - id: sibling
          prompt: independent
          depends_on: [source]
`);

    expect(result.error?.error).toContain("loop_group 'group' body: Node 'shared'");
    expect(result.error?.error).toContain('pre-loop-node-id');
    expect(result.error?.error).toContain('depends_on');
  });
});

describe('$node.execution.checkoutStart bindings (#3375)', () => {
  const load = (withValue: string, producerBody = 'prompt: work'): ParseResult =>
    parseWorkflow(
      `
name: checkout-binding
description: binds a producer's recorded checkout start
nodes:
  - id: implement
    ${producerBody}
  - id: guard
    script: guard
    runtime: bun
    depends_on: [implement]
    with:
      baseline: ${JSON.stringify(withValue)}
`,
      'checkout-binding.yaml'
    );

  it('accepts a whole binding to an upstream node that executes against the checkout', () => {
    const result = load('$implement.execution.checkoutStart');
    expect(result.error).toBeNull();
  });

  it('rejects the reference inside other text', () => {
    const result = load('start: $implement.execution.checkoutStart');
    expect(result.error?.error).toContain('only valid as the whole value');
  });

  it('rejects a producer that records no checkout start', () => {
    const result = load('$implement.execution.checkoutStart', 'cancel: stop here');
    expect(result.error?.error).toContain('records no checkout start');
  });

  it('rejects an unknown producer', () => {
    const result = load('$ghost.execution.checkoutStart');
    expect(result.error?.error).toContain("no node 'ghost' exists");
  });

  it('rejects the reference on a workflow: node, which cannot pass it to the child run', () => {
    const result = parseWorkflow(
      `
name: checkout-binding-child
description: a child launch cannot carry an execution fact
nodes:
  - id: implement
    prompt: work
  - id: child
    workflow: some-child
    depends_on: [implement]
    with:
      baseline: "$implement.execution.checkoutStart"
`,
      'checkout-binding-child.yaml'
    );
    expect(result.error?.error).toContain('a workflow: node cannot pass to its child run');
  });
});

describe('strict nested path validation', () => {
  const workflow = (reference: string, field = 'message'): string => `
name: nested-contract
description: nested access
nodes:
  - id: review
    bash: echo json
    output_format:
      properties:
        proposal:
          type: object
          properties:
            action: {type: string}
            items: {type: array, items: {type: object, properties: {value: {type: string}}}}
  - id: read
    depends_on: [review]
    ${field === 'when' ? `bash: echo read\n    when: "${reference} == 'add'"` : `approval: {message: "${reference}"}`}
`;
  for (const [path, segment] of [
    ['typo', 'typo'],
    ['typo.action', 'typo'],
    ['proposal.typo.action', 'typo'],
    ['proposal.action.typo', 'typo'],
    ['proposal.items.value', 'value'],
  ] as const) {
    it(`rejects undeclared segment of ${path} in templates and conditions`, () => {
      for (const surface of ['message', 'when']) {
        const result = parseWorkflow(workflow(`$review.output.${path}`, surface), 'nested.yaml');
        expect(result.workflow).toBeNull();
        expect(result.error?.error).toContain(`$review.output.${path}`);
        expect(result.error?.error).toContain(`field '${segment}'`);
      }
    });
  }
  it('rejects an unsupported suffix in current and prior templates and conditions', () => {
    for (const prefix of ['$review', '$LOOP_PREV.review']) {
      for (const surface of ['message', 'when']) {
        const reference = `${prefix}.output.proposal.action[0]`;
        const result = parseWorkflow(workflow(reference, surface), 'nested.yaml');
        expect(result.workflow).toBeNull();
        expect(result.error?.error).toContain('Unsupported output reference');
        expect(result.error?.error).toContain(reference);
      }
    }
  });

  it('ignores reference-shaped RHS text', () => {
    const yaml = workflow('$review.output.proposal.action', 'when').replace(
      "== 'add'",
      "== '$review.output.proposal.typo[0]'"
    );
    expect(parseWorkflow(yaml, 'nested.yaml').workflow).not.toBeNull();
  });
  it('preserves named input macros starting with output', () => {
    const yaml = workflow('$INPUTS.outputMode').replace(
      'nodes:',
      'inputs:\n  outputMode: {required: true}\nnodes:'
    );
    expect(parseWorkflow(yaml, 'nested.yaml').error).toBeNull();
  });

  it('does not authorize undeclared prior fields in the enclosing loop body', () => {
    const result = parseWorkflow(
      `
name: prior-contract
description: prior access
nodes:
  - id: group
    loop_group:
      max_iterations: 2
      until_bash: 'test $LOOP_PREV.work.output.proposal.typo = add'
      nodes:
        - id: work
          bash: echo json
          output_format:
            properties:
              proposal: {type: object, properties: {action: {type: string}}}
`,
      'prior.yaml'
    );
    expect(result.error?.error).toContain('$LOOP_PREV.work.output.proposal.typo');
    expect(result.error?.error).toContain("field 'typo'");
  });
});

describe('when syntax validation', () => {
  function workflowWithWhen(when: string): string {
    return `name: when-syntax
description: Condition syntax
nodes:
  - id: a
    bash: echo x
  - id: b
    bash: echo y
  - id: c
    bash: echo z
  - id: guarded
    bash: echo run
    depends_on: [a, b, c]
    when: ${JSON.stringify(when)}
`;
  }

  it('rejects grouping with a diagnostic naming the node and parentheses', () => {
    const result = parseWorkflow(
      workflowWithWhen("$a.output == 'x' && ($b.output == 'y' || $c.output == 'z')"),
      'when-syntax.yaml'
    );
    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain("Node 'guarded'");
    expect(result.error?.error).toContain('parentheses');
  });

  it('rejects malformed loop-body conditions while accepting scoped prior output', () => {
    const yaml = `name: prior-condition
description: Prior iteration syntax
nodes:
  - id: refine
    loop_group:
      until_bash: exit 0
      max_iterations: 2
      nodes:
        - id: work
          bash: echo done
        - id: guarded
          bash: echo run
          depends_on: [work]
          when: "$LOOP_PREV.work.output == 'done' && ($work.output == 'done')"
`;
    const result = parseWorkflow(yaml, 'prior-condition.yaml');
    expect(result.error?.error).toContain("Node 'guarded' field 'when'");
    expect(result.error?.error).toContain('parentheses');
    expect(
      parseWorkflow(
        yaml.replace("&& ($work.output == 'done')", "&& $work.output == 'done'"),
        'prior-condition.yaml'
      ).error
    ).toBeNull();
  });

  it('rejects a prior-iteration numeric comparison against a non-numeric literal', () => {
    const result = parseWorkflow(
      `name: prior-numeric-condition
description: Prior iteration numeric syntax
nodes:
  - id: refine
    loop_group:
      until_bash: exit 0
      max_iterations: 2
      nodes:
        - id: work
          bash: echo 90
        - id: guarded
          bash: echo run
          depends_on: [work]
          when: "$LOOP_PREV.work.output > 'high'"
`,
      'prior-numeric-condition.yaml'
    );
    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain("Node 'guarded' field 'when'");
    expect(result.error?.error).toContain('unsupported condition syntax');
  });

  it.each([
    'not a condition',
    "$a.output = 'x'",
    '$a.output ==',
    '$a.output == "x"',
    "$a.output == 'unterminated",
    "$a.output == 'x' &&",
    "|| $a.output == 'x'",
    "$a.output == 'x' || || $b.output == 'y'",
    "$a.output == 'x' && not-valid",
    "$a.output == 'x' || not-valid",
    "$a.output == 'absent' && not-valid",
    "($a.output == 'x')",
    "$a.output == 'x' && ($b.output == 'y' || $c.output == 'z')",
  ])('rejects invalid runtime syntax: %s', when => {
    const outputs = new Map([
      ['a', { state: 'completed' as const, output: 'x' }],
      ['b', { state: 'completed' as const, output: 'y' }],
      ['c', { state: 'completed' as const, output: 'z' }],
    ]);
    expect(evaluateCondition(when, outputs)).toEqual({ result: false, parsed: false });
    const result = parseWorkflow(workflowWithWhen(when), 'when-syntax.yaml');
    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain("Node 'guarded' field 'when'");
  });

  it.each([
    "$a.output > 'high'",
    "$a.output > ''",
    '$a.output <= true',
    "$a.output == 'x' || $b.output >= 'many'",
  ])('rejects a numeric comparison against a non-numeric literal: %s', when => {
    // A numeric output on every side still fails closed, so the node could never run.
    const outputs = new Map(
      ['a', 'b', 'c'].map(id => [id, { state: 'completed' as const, output: '90' }])
    );
    expect(evaluateCondition(when, outputs)).toEqual({ result: false, parsed: false });
    const result = parseWorkflow(workflowWithWhen(when), 'when-syntax.yaml');
    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain("Node 'guarded' field 'when'");
  });

  it('names grouping only when the expression has a parenthesis outside quotes', () => {
    const typo = parseWorkflow(workflowWithWhen("$a.output = '(x)'"), 'when-syntax.yaml');
    expect(typo.error?.error).toContain('unsupported condition syntax');
    expect(typo.error?.error).not.toContain('parentheses');
    const grouped = parseWorkflow(workflowWithWhen("($a.output == 'x')"), 'when-syntax.yaml');
    expect(grouped.error?.error).toContain('Grouping parentheses are not supported');
  });

  it('rejects unsupported syntax on an include node', () => {
    const result = parseWorkflow(
      `name: include-when
description: Condition on an include directive
nodes:
  - id: a
    bash: echo x
  - id: blk
    include: block
    depends_on: [a]
    when: "$a.output > 'high'"
`,
      'include-when.yaml'
    );
    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain(
      "Node 'blk' field 'when' has unsupported condition syntax"
    );
  });

  it.each([
    "$a.output == 'x' && $b.output == 'y' || $a.output == 'x' && $c.output == 'z'",
    "$a.output == '(x)'",
    "$a.output == 'x && y || z'",
    "$a.output != ''",
    '$a.output >= 0.9',
    "$a.output < '-3'",
    '$a.output == true',
  ])('loads supported syntax: %s', when => {
    expect(parseWorkflow(workflowWithWhen(when), 'when-syntax.yaml').error).toBeNull();
  });
});

describe('attention wait options from an upstream output_format (#4038)', () => {
  function parseWithOptionsItems(items: Record<string, unknown>): ParseResult {
    const outputFormat = {
      type: 'object',
      properties: { options: { type: 'array', items } },
      required: ['options'],
    };
    return parseWorkflow(
      `name: referenced-options
description: Options computed upstream
nodes:
  - id: plan
    prompt: Propose options.
    output_format: ${JSON.stringify(outputFormat)}
  - id: ask
    depends_on: [plan]
    wait:
      attention: Which one?
      form: select
      options: "$plan.output.options"
`,
      'referenced-options.yaml'
    );
  }

  it('loads a producer whose items declare { id, label? }', () => {
    const result = parseWithOptionsItems({
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id'],
    });
    expect(result.error).toBeNull();
  });

  it.each([
    ['items that are strings', { type: 'string' }],
    ['an id that is not required', { type: 'object', properties: { id: { type: 'string' } } }],
    [
      'an id that is not a string',
      { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    ],
    [
      'a property attention options do not have',
      {
        type: 'object',
        properties: { id: { type: 'string' }, score: { type: 'number' } },
        required: ['id'],
      },
    ],
  ])('rejects a producer with %s, naming the field and the producer', (_case, items) => {
    const result = parseWithOptionsItems(items);
    expect(result.error?.error).toContain("Node 'ask' field 'wait.options'");
    expect(result.error?.error).toContain(
      "must be an array of objects declaring only { id: string; label?: string } in 'plan's output_format"
    );
  });
});

describe('suspension placement', () => {
  it('rejects suspension nodes that can run concurrently', () => {
    const suspensionNodes = [
      `  - id: review
    approval:
      message: Review this`,
      `  - id: refine
    loop:
      prompt: Iterate.
      until: DONE
      max_iterations: 2
      interactive: true
      gate_message: Review.`,
      `  - id: child
    workflow: child-workflow`,
      `  - id: refine-group
    loop_group:
      until_bash: exit 0
      max_iterations: 2
      interactive: true
      gate_message: Review.
      nodes:
        - id: refine-step
          bash: echo refine`,
    ];
    for (const suspensionNode of suspensionNodes) {
      expect(
        parseError(`
name: parallel-suspensions
description: Two nodes cannot own the run cursor together
nodes:
  - id: wait-for-time
    wait:
      duration_ms: 60000
${suspensionNode}
`)
      ).toContain("Suspending nodes 'wait-for-time'");
    }
  });

  it('rejects waits nested below more than one loop_group boundary', () => {
    expect(
      parseError(`
name: nested-wait
description: nested wait
nodes:
  - id: outer
    loop_group:
      max_iterations: 2
      until_bash: exit 0
      nodes:
        - id: inner
          loop_group:
            max_iterations: 2
            until_bash: exit 0
            nodes:
              - id: delay
                wait:
                  duration_ms: 1000
`)
    ).toContain('wait nodes nested below another loop_group are not supported');
  });
});
