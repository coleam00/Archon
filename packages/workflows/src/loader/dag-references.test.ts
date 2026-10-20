// @archon-test-isolated
import {
  discoverFiles,
  expectRejected,
  inlinePrompt,
  parseError,
  parseWorkflowYaml,
  useTempWorkflowRoot,
} from './test-utils';
import { describe, it, expect } from 'bun:test';

describe('DAG output ref validation', () => {
  it.each([
    [
      'nested output paths in approval messages',
      `name: nested-approval-output
description: Nested structured output in a gate
nodes:
  - id: review
    prompt: Review the proposal
    output_format:
      type: object
      properties:
        proposal:
          type: object
          properties:
            action: { type: string }
            text: { type: string }
          required: [action, text]
      required: [proposal]
  - id: gate
    approval:
      message: |
        Proposed: $review.output.proposal.action
        $review.output.proposal.text
    depends_on: [review]
`,
    ],
    [
      'nested canonical output paths in when conditions',
      `name: nested-when-output
description: Nested structured output in a condition
nodes:
  - id: review
    bash: echo review
  - id: apply
    bash: echo apply
    depends_on: [review]
    when: "$review.output.proposal.action == 'add'"
`,
    ],
    [
      'nested prior-iteration output paths in loop-group conditions',
      `name: nested-loop-prev-output
description: Nested structured output from a prior iteration
nodes:
  - id: refine
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: work
          bash: echo work
        - id: guarded
          bash: echo guarded
          depends_on: [work]
          when: "$LOOP_PREV.work.output.proposal.action == 'add'"
`,
    ],
    [
      '$LOOP_PREV in a loop_group body when condition',
      `name: loop-prev-when
description: Prior iteration condition
nodes:
  - id: refine
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: work
          prompt: work
        - id: guarded
          prompt: guarded
          depends_on: [work]
          when: "$LOOP_PREV.work.output == 'done'"
`,
    ],
    [
      'output refs that use valid existing node IDs',
      `name: valid-refs
description: Valid output refs
nodes:
  - id: classify
    prompt: "Classify the input"
  - id: implement
    prompt: "Fix this: $classify.output"
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"
`,
    ],
  ])('accepts %s', (_, yaml) => {
    parseWorkflowYaml(yaml);
  });

  it.each<[string, string, (string | RegExp)[]]>([
    [
      'when: referencing an unknown node output',
      `name: bad-when-ref
description: Unknown output ref in when
nodes:
  - id: classify
    prompt: "Classify the input"
  - id: implement
    prompt: "Implement the fix"
    depends_on: [classify]
    when: "$clasify.output == 'BUG'"
`,
      [/unknown node/i, 'clasify'],
    ],
    [
      'prompt: referencing an unknown node output',
      `name: bad-prompt-ref
description: Unknown output ref in prompt
nodes:
  - id: analyze
    prompt: "Analyze the code"
  - id: fix
    prompt: "Fix this: $analyize.output"
    depends_on: [analyze]
`,
      [/unknown node/i, 'analyize'],
    ],
    // bash: (like script/cancel/approval.message/until_bash) is substituted at
    // runtime, so a dangling ref there silently resolves to '' — it must be caught
    // at load time, same as prompt/when refs.
    [
      'a dangling bash node $nodeId.output ref',
      `name: bash-unknown-ref
description: Bash node with a dangling output ref
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    bash: "echo $typo.output"
    depends_on: [step1]
`,
      ['$typo.output'],
    ],
    // A script node stands in for the other code/text surfaces the scan covers.
    [
      'a dangling script/cancel/approval.message/until_bash ref',
      `name: script-unknown-ref
description: Script node with a dangling output ref
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    script: "console.log($missing.output)"
    runtime: bun
    depends_on: [step1]
`,
      ['$missing.output'],
    ],
    [
      '$nodeId.output inside fenced code blocks in prompt: bodies',
      `name: fenced-doc
description: Prompt body with a fenced code example mentioning a literal output ref
nodes:
  - id: writer
    prompt: |
      Author a workflow that uses a script node:

      \`\`\`yaml
      script: |
        const data = $other-node.output;
        console.log(data);
      \`\`\`
`,
      ['$other-node.output'],
    ],
    [
      '$nodeId.output inside inline backtick code in prompt: bodies',
      `name: inline-doc
description: Prompt body that mentions a placeholder via inline backticks
nodes:
  - id: writer
    prompt: |
      Use \`$nodeId.output\` to reference a sibling node's output.
      For Python, prefer \`json.loads("""$nodeId.output""")\`.
`,
      ['$nodeId.output'],
    ],
    [
      'a dangling shorthand when ref',
      `name: bad-when-shorthand
description: dangling shorthand condition
nodes:
  - id: task
    prompt: work
    when: "$caller.status == 'ok'"
`,
      ["field 'when'", '$caller.status'],
    ],
    [
      'a dangling approval.on_reject.prompt ref',
      `name: bad-rejection-ref
description: dangling rejection prompt ref
nodes:
  - id: gate
    approval:
      message: Approve?
      on_reject:
        prompt: "Revise $caller.output"
`,
      ["field 'approval.on_reject.prompt'", '$caller.output'],
    ],
    // The scan reads the body verbatim, so a real (unknown) ref in prose and a
    // fenced example are both live; the prose one is reported first.
    [
      'an unknown $nodeId.output ref outside code',
      `name: mixed-ref
description: Real (unknown) ref in prose plus a fenced doc example
nodes:
  - id: step1
    prompt: |
      Build on $missing-node.output to do the work.

      Example:

      \`\`\`
      const x = $other-node.output;
      \`\`\`
`,
      ['missing-node'],
    ],
    [
      '$nodeId.output inside fenced code in loop.prompt',
      `name: loop-fenced
description: Loop with a fenced doc example in its prompt
nodes:
  - id: my-loop
    loop:
      prompt: |
        Iterate. Example syntax:

        \`\`\`
        $other-node.output
        \`\`\`
      until: DONE
      max_iterations: 3
`,
      ['$other-node.output'],
    ],
  ])('rejects %s', (_, yaml, expected) => {
    expectRejected(yaml, expected);
  });

  it('rejects unknown and non-upstream output refs in wait conditions', () => {
    const waitWorkflow = (nodes: string): string =>
      `name: bad-wait-ref\ndescription: Invalid output refs in waits\nnodes:\n${nodes}`;

    expect(
      parseError(
        waitWorkflow(`  - id: schedule
    bash: echo 2026-08-25T22:00:00Z
  - id: wait-for-window
    wait:
      until: "$schedule.output"
`)
      )
    ).toContain('not an upstream dependency');
    expect(
      parseError(
        waitWorkflow(`  - id: wait-for-checks
    wait:
      event: "$missing.output"
      deadline_ms: 60000
`)
      )
    ).toContain("unknown node '$missing.output'");
    expect(
      parseError(
        waitWorkflow(`  - id: check
    bash: echo failed
  - id: wait-for-action
    wait:
      attention: "Rerun $check.output, then resume."
`)
      )
    ).toContain('not an upstream dependency');
  });

  describe('after include expansion', () => {
    const root = useTempWorkflowRoot();

    it('treats $INPUTS.output as a declared input macro before include expansion', async () => {
      const result = await discoverFiles(root(), {
        'input-output-block.yaml': `name: input-output-block
description: Block with an input named output
inputs:
  output:
    required: true
nodes:
  - id: review
    prompt: "Review $INPUTS.output"
`,
        'input-output-parent.yaml': `name: input-output-parent
description: Includes the input output block
nodes:
  - id: inc
    include: input-output-block
    with:
      output: bound-value
`,
      });
      expect(result.errors).toHaveLength(0);
      const parent = result.workflows.find(
        item => item.workflow.name === 'input-output-parent'
      )?.workflow;
      const review = parent?.nodes.find(node => node.id === 'inc__review');
      expect(inlinePrompt(review)).toBe('Review bound-value');
    });
  });
});

describe('when: whole-output comparison against an AI producer (#2566)', () => {
  /** A workflow whose `decide` node gates on `when` after the given producer nodes. */
  const gated = (producers: string, when: string, dependsOn: string): string =>
    `name: whole-output
description: Compares a node's whole output
nodes:
${producers}
  - id: decide
    prompt: "Decide"
    depends_on: [${dependsOn}]
    when: "${when}"
`;

  it('rejects a bare $node.output comparison when the producer is a prompt node', () => {
    const message = parseError(
      gated(
        '  - id: analyze\n    prompt: "Analyze the issue"',
        "$analyze.output == 'BUG'",
        'analyze'
      )
    );
    expect(message).toContain("compares the whole output of AI node 'analyze'");
    // The message must name the fix, not just the problem.
    expect(message).toContain('output_format');
    expect(message).toContain("$analyze.output.status == 'BUG'");
  });

  it.each([
    // A command file is a prompt in another file.
    [
      'a command producer',
      '  - id: analyze\n    command: analyze-issue',
      "$analyze.output == 'BUG'",
      'analyze',
      'analyze',
    ],
    [
      'a numeric operator',
      '  - id: score\n    prompt: "Score it"',
      "$score.output > '80'",
      'score',
      'score',
    ],
    [
      'a compound expression',
      '  - id: flag\n    bash: "echo yes"\n  - id: analyze\n    prompt: "Analyze"',
      "$flag.output == 'yes' && $analyze.output == 'BUG'",
      'flag, analyze',
      'analyze',
    ],
  ])('rejects it for %s', (_, producers, when, dependsOn, producer) => {
    expect(parseError(gated(producers, when, dependsOn))).toContain(
      `whole output of AI node '${producer}'`
    );
  });

  it('rejects it for a loop producer', () => {
    const message = parseError(
      gated(
        '  - id: refine\n    loop:\n      prompt: "Refine until done"\n      until: DONE\n      max_iterations: 3',
        "$refine.output == 'DONE'",
        'refine'
      )
    );
    expect(message).toContain("whole output of AI node 'refine'");
    // Since #2563 a `loop:` is schema-capable, so it gets the SAME remedy as a
    // prompt node: declare output_format and compare a field. (A `loop_group:` still
    // gets its own reason — it never calls the provider itself.)
    expect(message).toContain("Declare 'output_format'");
  });

  it('rejects it for a loop_group producer', () => {
    const message = parseError(
      gated(
        '  - id: refine\n    loop_group:\n      until: DONE\n      max_iterations: 3\n      nodes:\n        - id: body\n          prompt: "Do a pass"',
        "$refine.output == 'DONE'",
        'refine'
      )
    );
    expect(message).toContain("whole output of AI node 'refine'");
    expect(message).toContain("last iteration's raw text");
  });

  it('rejects it for a loop_group producer that declares output_format, for its own reason', () => {
    // Unlike `loop:`, a loop_group KEEPS `output_format` through the transform — so the
    // "dropped at parse" reason would be wrong here. The group is still rejected
    // because its completion returns the last iteration's text, never the JSON.
    const message = parseError(
      gated(
        `  - id: refine
    output_format:
      type: object
      properties:
        status:
          type: string
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: body
          prompt: "Do a pass"`,
        "$refine.output == 'DONE'",
        'refine'
      )
    );
    expect(message).toContain("last iteration's raw text");
    expect(message).not.toContain("dropped from a 'loop:' node");
  });

  it('rejects it from a loop_group body referencing an enclosing AI node', () => {
    expect(
      parseError(`name: ai-enclosing
description: Body node branching on an outer AI node's whole output
nodes:
  - id: analyze
    prompt: "Analyze"
  - id: refine
    depends_on: [analyze]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: body
          prompt: "Do a pass"
          when: "$analyze.output == 'BUG'"
`)
    ).toContain("whole output of AI node 'analyze'");
  });

  it.each([
    // A bash producer's stdout is author-controlled and exact.
    [
      'a bash producer',
      `  - id: check\n    bash: "test -f README.md && echo 'true' || echo 'false'"`,
      "$check.output == 'true'",
      'check',
    ],
    [
      'a script producer',
      `  - id: check\n    runtime: bun\n    script: "console.log('ok')"`,
      "$check.output == 'ok'",
      'check',
    ],
    // A certified exec node's whole output is its canonical JSON document — still
    // author-controlled and exact, so the #2566 rejection has no reason to fire.
    [
      'a script producer that declares a contract (#2453)',
      `  - id: check
    runtime: bun
    script: "console.log('{\\"ok\\":true}')"
    output_format:
      type: object
      properties:
        ok: { type: boolean }
      required: [ok]`,
      "$check.output.ok == 'true'",
      'check',
    ],
    [
      'an AI producer that declares output_format',
      `  - id: analyze
    prompt: "Analyze"
    output_format:
      type: object
      properties:
        status:
          type: string`,
      "$analyze.output == '{}'",
      'analyze',
    ],
    // `output_format` reaches a LoopNode — it runs its own sendQuery — so the loop's
    // output IS the validated JSON document and declaring a schema is a real opt-out,
    // exactly as it is for a prompt node (#2563).
    [
      'a loop producer that declares an output_format (#2563)',
      `  - id: refine
    output_format:
      type: object
      properties:
        status:
          type: string
    loop:
      prompt: "Refine until done"
      until: DONE
      max_iterations: 3`,
      "$refine.output == 'DONE'",
      'refine',
    ],
    [
      'a field access on an AI producer',
      '  - id: analyze\n    prompt: "Analyze"',
      "$analyze.output.status == 'BUG'",
      'analyze',
    ],
  ])('accepts %s', (_, producers, when, dependsOn) => {
    parseWorkflowYaml(gated(producers, when, dependsOn));
  });

  it('accepts a $INPUTS ref, which names no producer at all', () => {
    parseWorkflowYaml(`name: inputs-when
description: Branching on a caller-supplied input
inputs:
  mode:
    default: fast
nodes:
  - id: fast-path
    prompt: "Go fast"
    when: "$INPUTS.mode == 'fast'"
`);
  });

  it('rejects an unparseable when:', () => {
    const message = parseError(
      gated('  - id: analyze\n    prompt: "Analyze"', "$analyze.output = 'BUG'", 'analyze')
    );
    expect(message).toContain("Node 'decide' field 'when'");
    expect(message).toContain('unsupported condition syntax');
  });

  describe('after include expansion', () => {
    const root = useTempWorkflowRoot();

    it('fires on the FLATTENED graph, catching a hazard that only appears after include expansion', async () => {
      // The block's sink is an AI node; the caller gates on `$blk.output`, which the
      // expander rewrites to that sink. Pre-expansion the producer is an `include:`
      // node (exempt), so only the post-expansion revalidation can catch this.
      const result = await discoverFiles(root(), {
        'block.yaml': `name: block
description: block whose sink is an AI node
nodes:
  - id: verdict
    prompt: "Give a verdict"
`,
        'includes-block.yaml': `name: includes-block
description: gates on an included block's whole output
nodes:
  - id: blk
    include: block
  - id: act
    prompt: "Act"
    depends_on: [blk]
    when: "$blk.output == 'PASS'"
`,
      });
      expect(result.workflows.find(w => w.workflow.name === 'includes-block')).toBeUndefined();
      const error = result.errors.find(e => e.filename.includes('includes-block'));
      expect(error?.error).toContain('compares the whole output of AI node');
    });
  });
});
