// @archon-test-isolated
import {
  discoverFiles,
  mockLogger,
  parseError,
  parseWorkflow,
  parseWorkflowYaml,
  useTempWorkflowRoot,
} from './test-utils';
import { describe, it, expect } from 'bun:test';

/**
 * Most warnings are raised by `parseWorkflow` and are asserted on its result. The
 * loop_group sink-shape warnings (#2756) are raised only by discovery, on the
 * EXPANDED graph, so a fixture containing a `loop_group` asserts its warnings through
 * `discoveredWarnings`: a parse-only assertion that no warning fires would pass while
 * discovery added one.
 */
const workflowLines = (lines: string[]): string =>
  ['name: test', 'description: test', ...lines].join('\n');

const parsedWarnings = (lines: string[]): string[] =>
  parseWorkflowYaml(workflowLines(lines)).warnings;

describe('single conditional dependency trigger rule warning (#3783)', () => {
  const CONDITIONAL_JOIN = 'needs a successful dependency';

  it.each([
    {
      label: 'its only dependency is conditional',
      deps: ['a'],
      rule: 'none_failed_min_one_success',
      warns: true,
    },
    {
      label: 'its only dependency is unconditional',
      deps: ['c'],
      rule: 'none_failed_min_one_success',
      warns: false,
    },
    {
      label: 'it joins conditional branches',
      deps: ['a', 'b'],
      rule: 'none_failed_min_one_success',
      warns: false,
    },
    {
      label: 'it joins conditional and unconditional nodes',
      deps: ['a', 'c'],
      rule: 'none_failed_min_one_success',
      warns: false,
    },
    {
      label: 'it uses all_done after a conditional node',
      deps: ['a'],
      rule: 'all_done',
      warns: false,
    },
  ])('warns=$warns when $label', ({ deps, rule, warns }) => {
    const { warnings } = parseWorkflowYaml(`name: conditional-join
description: Conditional join warning
inputs:
  run: {}
nodes:
  - id: a
    bash: echo a
    when: "$INPUTS.run == true"
  - id: b
    bash: echo b
    when: "$INPUTS.run != true"
  - id: c
    bash: echo c
  - id: join
    bash: echo joined
    depends_on: ${JSON.stringify(deps)}
    trigger_rule: ${rule}
`);
    const advisories = warnings.filter(w => w.includes(CONDITIONAL_JOIN));
    expect(advisories).toHaveLength(warns ? 1 : 0);
    if (warns) {
      expect(advisories[0]).toContain("Node 'join'");
      expect(advisories[0]).toContain("'a'");
      expect(advisories[0]).toContain('all_done');
      expect(advisories[0]).toContain('/reference/workflow-language/#trigger_rule-values');
    }
  });

  it('warns when the only dependency is a conditional include', () => {
    const { warnings } = parseWorkflowYaml(`name: conditional-include-join
description: Join after a conditional block
inputs:
  run: {}
nodes:
  - id: inc
    include: block
    when: "$INPUTS.run == true"
  - id: join
    depends_on: [inc]
    trigger_rule: none_failed_min_one_success
    bash: echo joined
`);
    expect(warnings.filter(w => w.includes(CONDITIONAL_JOIN))).toEqual([
      expect.stringContaining("Node 'join'"),
    ]);
  });

  it('warns inside a loop_group body', () => {
    const { warnings } = parseWorkflowYaml(`name: conditional-loop-join
description: Conditional join inside a loop
inputs:
  run: {}
nodes:
  - id: group
    loop_group:
      until_bash: exit 0
      max_iterations: 1
      nodes:
        - id: optional
          bash: echo optional
          when: "$INPUTS.run == true"
        - id: join
          depends_on: [optional]
          trigger_rule: none_failed_min_one_success
          bash: echo joined
`);
    expect(warnings.filter(w => w.includes(CONDITIONAL_JOIN))).toEqual([
      expect.stringContaining("Node 'join'"),
    ]);
  });

  describe('through include expansion', () => {
    const root = useTempWorkflowRoot();

    it('does not warn inside a block that a conditional include skips as a whole', async () => {
      // Expansion copies the include's `when` onto the block's entry node, so judging the
      // expanded graph would flag `inc__join` even though the whole block skipping is the intent.
      const result = await discoverFiles(root(), {
        'block.yaml': `name: block
description: Unconditional reusable join
nodes:
  - id: up
    bash: echo up
  - id: join
    depends_on: [up]
    trigger_rule: none_failed_min_one_success
    bash: echo joined
`,
        'top.yaml': `name: top
description: Conditional composition
inputs:
  run: {}
nodes:
  - id: inc
    include: block
    when: "$INPUTS.run == true"
`,
      });
      expect(result.errors).toEqual([]);
      expect(result.workflows).toHaveLength(2);
      for (const { parseWarnings } of result.workflows) {
        expect((parseWarnings ?? []).filter(w => w.includes(CONDITIONAL_JOIN))).toEqual([]);
      }
    });
  });
});

describe('parse warnings channel (#3444)', () => {
  it('reports parse warnings to the author without logging them at warn', () => {
    // Discovery parses every workflow on each list or run, so a warn log here
    // would repeat for workflows nobody asked about. The warnings array is the
    // channel validate, list, run, and the API read.
    mockLogger.warn.mockClear();
    const yaml = `
name: parse-warnings
description: Deprecated interactive declaration, a legacy gate, a legacy loop, and a typo
interactive: true
nodes:
  - id: gate
    approval:
      message: "Review?"
  - id: legacy
    loop:
      prompt: p
      until: DONE
      max_iterations: 2
  - id: typo
    bash: echo hi
    contxt: fresh
`;
    for (let parse = 0; parse < 2; parse++) {
      const result = parseWorkflow(yaml, 'parse-warnings.yaml');
      expect(result.error).toBeNull();
      expect(result.warnings).toHaveLength(4);
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('unknown key warnings (#2213)', () => {
  it('should warn when a node has an unknown key', () => {
    const pw = parsedWarnings([
      'nodes:',
      '  - id: plan',
      '    command: my-command',
      '    unknown_field: true',
    ]);
    expect(pw.length).toBe(1);
    expect(pw[0]).toContain("unknown key 'unknown_field'");
    expect(pw[0]).toContain('will be ignored');
  });

  it('should hint when a workflow-level key is misplaced on a node', () => {
    const pw = parsedWarnings([
      'nodes:',
      '  - id: plan',
      '    command: my-command',
      '    tags: [review]',
    ]);
    expect(pw.length).toBe(1);
    expect(pw[0]).toContain("unknown key 'tags'");
    expect(pw[0]).toContain("'tags' is valid at workflow level, not on individual nodes.");
  });

  it('rejects a key owned by another node mode, naming node, key and owner (#2478)', () => {
    expect(
      parseError(
        workflowLines(['nodes:', '  - id: plan', '    prompt: plan it', '    runtime: bun'])
      )
    ).toBe(
      "DAG node validation failed: Node 'plan': 'runtime' is only supported on script nodes, not on prompt nodes."
    );
  });

  it('should warn when the workflow itself has an unknown key', () => {
    const pw = parsedWarnings(['max_retries: 3', 'nodes:', '  - id: n', '    prompt: p']);
    expect(pw.length).toBe(1);
    expect(pw[0]).toContain("unknown key 'max_retries'");
  });

  it('should not warn for valid node keys', () => {
    expect(
      parsedWarnings([
        'nodes:',
        '  - id: n',
        '    prompt: hello',
        '    model: some-model',
        '    context: fresh',
      ])
    ).toEqual([]);
  });

  it('should collect warnings from multiple nodes', () => {
    const pw = parsedWarnings([
      'nodes:',
      '  - id: a',
      '    prompt: hello',
      '    typo_key: 1',
      '  - id: b',
      '    bash: echo hi',
      '    another_typo: 2',
    ]);
    expect(pw.length).toBe(2);
    expect(pw[0]).toContain("Node 'a'");
    expect(pw[1]).toContain("Node 'b'");
  });

  it('should hint when a node-only key is misplaced at workflow level', () => {
    // 'command' is valid on nodes but not at workflow level
    const pw = parsedWarnings(['command: my-command', 'nodes:', '  - id: n', '    prompt: p']);
    expect(pw.length).toBe(1);
    expect(pw[0]).toContain("'command'");
    expect(pw[0]).toContain('valid on individual nodes');
  });

  describe('nested keys', () => {
    const root = useTempWorkflowRoot();

    const discoveredWarnings = async (lines: string[]): Promise<string[]> => {
      const result = await discoverFiles(root(), { 'test.yaml': workflowLines(lines) });
      expect(result.workflows.length).toBe(1);
      return [...(result.workflows[0].parseWarnings ?? [])];
    };

    it('should warn on an unknown key inside approval:', () => {
      const unknownKeyWarnings = parsedWarnings([
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      capture_reponse: true', // typo for capture_response
      ]).filter(w => w.includes('unknown key'));
      expect(unknownKeyWarnings.length).toBe(1);
      expect(unknownKeyWarnings[0]).toContain("Node 'gate'");
      expect(unknownKeyWarnings[0]).toContain("unknown key 'approval.capture_reponse'");
    });

    it('should warn on an unknown key inside approval.on_reject (two levels down)', () => {
      const pw = parsedWarnings([
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      on_reject:',
        '        prompt: try again',
        '        max_retries: 2', // real field is max_attempts
      ]);
      // Also carries the on_reject deprecation warning — the unknown-key warning
      // under test is asserted independently of it.
      const unknownKeyWarnings = pw.filter(w => w.includes('unknown key'));
      expect(unknownKeyWarnings.length).toBe(1);
      expect(unknownKeyWarnings[0]).toContain("unknown key 'approval.on_reject.max_retries'");
      expect(pw.some(w => w.includes("'approval.on_reject' and '$REJECTION_REASON'"))).toBe(true);
    });

    it.each([
      [
        'retry:',
        [
          '  - id: n',
          '    prompt: hello',
          '    retry:',
          '      max_attempts: 2',
          '      backoff_ms: 5000',
        ],
        'retry.backoff_ms',
      ],
      [
        'context:',
        [
          '  - id: source',
          '    prompt: source',
          '  - id: consumer',
          '    prompt: consumer',
          '    depends_on: [source]',
          '    context:',
          '      resume: source',
          '      fork: false',
        ],
        'context.fork',
      ],
      // The agent id is author-chosen, so it must appear in the path verbatim
      // rather than being reported as an unknown key itself.
      [
        'an agents entry',
        [
          '  - id: n',
          '    prompt: hello',
          '    agents:',
          '      my-agent:',
          '        description: does things',
          '        prompt: do it',
          '        disallowed_tools: [Bash]',
        ],
        'agents.my-agent.disallowed_tools',
      ],
    ])('should warn on an unknown key inside %s', (_, nodeLines, key) => {
      const pw = parsedWarnings(['nodes:', ...nodeLines]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain(`unknown key '${key}'`);
    });

    it('should accept every strict wait key at the nested warning boundary', () => {
      expect(
        parsedWarnings([
          'nodes:',
          '  - id: duration',
          '    wait:',
          '      duration_ms: 1000',
          '  - id: until',
          '    depends_on: [duration]',
          '    wait:',
          "      until: '2026-09-01T12:00:00Z'",
          '  - id: event',
          '    depends_on: [until]',
          '    wait:',
          '      event: checks.complete',
          '      deadline_ms: 60000',
          '  - id: attention',
          '    depends_on: [event]',
          '    wait:',
          '      attention: Re-run CI, then resume.',
        ])
      ).toEqual([]);
    });

    it('should warn on an unknown key on a loop_group body node', async () => {
      const pw = await discoveredWarnings([
        'nodes:',
        '  - id: refine',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: check',
        '          prompt: check it',
        '          contxt: fresh',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("Node 'refine' → loop_group node 'check'");
      expect(pw[0]).toContain("unknown key 'contxt'");
    });

    it('should warn on an unknown key inside the loop_group control block', async () => {
      const pw = await discoveredWarnings([
        'nodes:',
        '  - id: refine',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      max_attempts: 4', // not a loop control field
        '      nodes:',
        '        - id: check',
        '          prompt: check it',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("unknown key 'loop_group.max_attempts'");
    });

    it('should warn on an unknown key inside a workflow-level worktree block', () => {
      const pw = parsedWarnings([
        'worktree:',
        '  enabled: true',
        '  base_branch: main', // worktree policy has only `enabled`
        'nodes:',
        '  - id: n',
        '    prompt: p',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("Workflow 'test'");
      expect(pw[0]).toContain("unknown key 'worktree.base_branch'");
    });

    it('should not warn on valid nested keys, including a clean loop_group body', async () => {
      const pw = await discoveredWarnings([
        'worktree:',
        '  enabled: true',
        'nodes:',
        '  - id: refine',
        '    loop_group:',
        '      until: DONE',
        '      max_iterations: 3',
        '      interactive: true',
        '      gate_message: continue?',
        '      nodes:',
        '        - id: check',
        '          prompt: check it',
        '          retry:',
        '            max_attempts: 2',
        '            delay_ms: 1000',
        '  - id: gate',
        '    depends_on: [refine]',
        '    approval:',
        '      message: ok?',
        '      capture_response: true',
        '      on_reject:',
        '        prompt: again',
        '        max_attempts: 2',
      ]);
      // Every key used here IS valid — none should trip the unknown-key check.
      // The interactive loop, `on_reject`, `capture_response` and the prose `until:`
      // channel are deliberately deprecated, so this fixture legitimately produces
      // THOSE warnings too, asserted in their own describe block below.
      expect(pw.some(w => w.includes('unknown key'))).toBe(false);
      expect(pw).toEqual([
        expect.stringContaining("Node 'refine': the prose 'loop_group.until' completion signal"),
        expect.stringContaining("Node 'refine': loop 'interactive:'"),
        expect.stringContaining("Node 'gate': 'approval.on_reject'"),
        expect.stringContaining("Node 'gate': 'approval.capture_response'"),
      ]);
    });

    it('should not treat free-form output_format keys as unknown', () => {
      expect(
        parsedWarnings([
          'nodes:',
          '  - id: n',
          '    prompt: hello',
          '    output_format:',
          '      type: object',
          '      properties:',
          '        anything_at_all:',
          '          type: string',
        ])
      ).toEqual([]);
    });
  });
});

describe('loop_group pause-sink warnings (#2707, #4043)', () => {
  const root = useTempWorkflowRoot();

  const discoveredWarnings = async (yaml: string): Promise<string[]> => {
    const result = await discoverFiles(root(), { 'test.yaml': yaml });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    return [...(result.workflows[0].parseWarnings ?? [])];
  };

  it('should accept an attention-terminated loop_group whose completion reads the answer, with no warning', async () => {
    expect(
      await discoveredWarnings(`
name: loop-group-attention-terminal
description: An attention wait as the body's sole terminal sink, completion reading its decision
nodes:
  - id: grp
    loop_group:
      until_bash: 'decision=$check.output.decision; [ "$decision" = "approve" ]'
      max_iterations: 3
      nodes:
        - id: work
          prompt: "do work. Feedback: $LOOP_PREV.check.output.text"
        - id: check
          depends_on: [work]
          wait:
            attention: "Continue?"
            form: approval
`)
    ).toEqual([]);
  });

  it('does not ask until_bash to read a terminal pause that its own when: can skip', async () => {
    expect(
      await discoveredWarnings(`
name: loop-group-conditional-attention
description: Ask only when blocked
nodes:
  - id: grp
    loop_group:
      until_bash: test $work.output != blocked
      max_iterations: 3
      nodes:
        - id: work
          bash: "printf done"
        - id: ask
          depends_on: [work]
          when: "$work.output == 'blocked'"
          wait:
            attention: "Unblock?"
`)
    ).toEqual([]);
  });

  it.each([
    ['an attention wait', 'wait:\n            attention: "Continue?"'],
    ['a legacy gate', 'approval:\n            message: "Continue?"'],
  ])("warns when until_bash does not reference the loop_group's terminal %s", async (_, pause) => {
    const pw = (
      await discoveredWarnings(`
name: loop-group-pause-completion-not-referenced
description: A pause-terminated body whose completion channel ignores the answer
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: work
          prompt: "do work"
        - id: check
          depends_on: [work]
          ${pause}
`)
    ).filter(w => w.includes('does not reference'));
    expect(pw).toHaveLength(1);
    expect(pw[0]).toContain("Node 'check'");
    expect(pw[0]).toContain('$check.output');
  });
});

describe('legacy pause and loop deprecation warnings', () => {
  const root = useTempWorkflowRoot();

  const discoveredWarnings = async (lines: string[]): Promise<string[]> => {
    const result = await discoverFiles(root(), { 'test.yaml': workflowLines(lines) });
    expect(result.workflows.length).toBe(1);
    return [...(result.workflows[0].parseWarnings ?? [])];
  };

  // Each legacy answerable pause warns once per file, naming its attention-form
  // replacement (#4042). The runtime is unchanged, so every shape still loads.
  it.each([
    [
      'a plain approval gate',
      ['  - id: gate', '    approval:', '      message: ok?'],
      [
        "Node 'gate': 'approval:' is deprecated. Write 'wait: { attention: <message>, form: approval }' instead; the next node reads '$<id>.output.decision' and '$<id>.output.text'. A legacy reject cancels the run, while an attention wait continues with decision 'reject', so add a 'cancel:' node with when: \"$<id>.output.decision == 'reject'\" where rejecting should end the run. It keeps running as before until rewritten.",
      ],
    ],
    [
      'approval.decisions',
      [
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      decisions:',
        '        - id: approve',
        '        - id: needs-work',
      ],
      [
        "Node 'gate': 'approval.decisions' is deprecated. Write 'wait: { attention: <message>, form: select, options: <the same decisions> }' instead; the output is the same {decision, text}. It keeps running as before until rewritten.",
      ],
    ],
    [
      'approval.capture_response',
      ['  - id: gate', '    approval:', '      message: ok?', '      capture_response: false'],
      [
        expect.stringContaining("Node 'gate': 'approval:' is deprecated."),
        "Node 'gate': 'approval.capture_response' is deprecated. An attention wait always records the answer; the next node reads '$<id>.output.text'. It keeps running as before until rewritten.",
      ],
    ],
    [
      'approval.on_reject',
      [
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      on_reject:',
        '        prompt: fix it',
      ],
      [
        "Node 'gate': 'approval.on_reject' and '$REJECTION_REASON' are deprecated. Write 'wait: { attention: <message>, form: approval }' followed by a rework node with when: \"$<id>.output.decision == 'reject'\" that reads '$<id>.output.text'. To repeat the rework, write a 'loop_group' whose body ends in the wait; the rework node comes first and reads '$LOOP_PREV.<id>.output.text'. It keeps running as before until rewritten.",
      ],
    ],
    [
      'an interactive loop',
      [
        '  - id: iterate',
        '    loop:',
        '      prompt: work',
        '      until_bash: "exit 0"',
        '      max_iterations: 5',
        '      interactive: true',
        '      gate_message: continue?',
      ],
      [
        "Node 'iterate': loop 'interactive:' with 'gate_message' and '$LOOP_USER_INPUT' is deprecated. Write a 'loop_group' whose body ends in a 'wait: attention' node instead; the next iteration reads '$LOOP_PREV.<id>.output.text', and 'until_bash' checks the answer at '$<id>.output'. It keeps running as before until rewritten.",
      ],
    ],
    [
      'an interactive loop_group',
      [
        '  - id: iterate',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 5',
        '      interactive: true',
        '      gate_message: continue?',
        '      nodes:',
        '        - id: work',
        '          prompt: work',
      ],
      [expect.stringContaining("Node 'iterate': loop 'interactive:' with 'gate_message'")],
    ],
  ])('warns on %s with its attention-form replacement', async (_, nodeLines, expected) => {
    expect(await discoveredWarnings(['nodes:', ...nodeLines])).toEqual(expected);
  });

  it('warns once per file per shape, naming every node that uses it, loop_group bodies included', async () => {
    expect(
      await discoveredWarnings([
        'nodes:',
        '  - id: first',
        '    approval:',
        '      message: ok?',
        '  - id: grp',
        '    depends_on: [first]',
        '    loop_group:',
        '      until_bash: \'decision=$second.output.decision; test "$decision" = approve\'',
        '      max_iterations: 2',
        '      nodes:',
        '        - id: work',
        '          prompt: work',
        '        - id: second',
        '          depends_on: [work]',
        '          approval:',
        '            message: again?',
      ])
    ).toEqual([expect.stringContaining("Nodes 'first', 'second': 'approval:' is deprecated.")]);
  });

  it("the on_reject replacement repeats rework by reading $LOOP_PREV, keeping the wait as the body's sink", async () => {
    const groupLines = (bodyLines: string[]): string[] => [
      'nodes:',
      '  - id: grp',
      '    loop_group:',
      '      until_bash: \'decision=$review.output.decision; test "$decision" = approve\'',
      '      max_iterations: 3',
      '      nodes:',
      ...bodyLines,
    ];
    expect(
      await discoveredWarnings(
        groupLines([
          '        - id: rework',
          '          prompt: "Revise. Feedback, if any: $LOOP_PREV.review.output.text"',
          '        - id: review',
          '          depends_on: [rework]',
          '          wait: { attention: ok?, form: approval }',
        ])
      )
    ).toEqual([]);

    // A rework node after the wait, as a one-shot replacement writes it, cannot repeat.
    expect(
      parseError(
        workflowLines(
          groupLines([
            '        - id: review',
            '          wait: { attention: ok?, form: approval }',
            '        - id: rework',
            '          depends_on: [review]',
            '          when: "$review.output.decision == \'reject\'"',
            '          prompt: "Revise: $review.output.text"',
          ])
        )
      )
    ).toContain("wait node 'review' must be the body's sole terminal sink");
  });

  it('does not warn on attention waits, the replacement', () => {
    expect(
      parsedWarnings([
        'nodes:',
        '  - id: ask',
        '    wait:',
        '      attention: Which base?',
        '      form: select',
        '      options:',
        '        - id: use-main',
        '        - id: use-dev',
        '  - id: stop',
        '    depends_on: [ask]',
        '    when: "$ask.output.decision == \'use-dev\'"',
        '    cancel: not supported yet',
      ])
    ).toEqual([]);
  });

  it('does not warn about nested group pauses when an enclosing group owns a named session', async () => {
    const pw = await discoveredWarnings([
      'nodes:',
      '  - id: source',
      '    prompt: Start the owner session',
      '  - id: outer',
      '    depends_on: [source]',
      '    loop_group:',
      '      until_bash: "exit 1"',
      '      max_iterations: 2',
      '      nodes:',
      '        - id: owner',
      '          prompt: Continue',
      '          context: { resume: source }',
      '        - id: middle',
      '          depends_on: [owner]',
      '          loop_group:',
      '            until_bash: "exit 1"',
      '            max_iterations: 2',
      '            nodes:',
      '              - id: inner',
      '                loop_group:',
      '                  until_bash: "exit 1"',
      '                  max_iterations: 2',
      '                  interactive: true',
      '                  gate_message: Review',
      '                  nodes:',
      '                    - id: work',
      '                      prompt: Work',
    ]);
    expect(pw.some(w => w.includes('#2753'))).toBe(false);
  });

  it('warns on an interactive loop nested inside a loop_group body', async () => {
    // Exercises the recursion into loop_group.nodes — the outer group's own
    // body-terminal sink is 'inner-loop' (a plain interactive `loop:` node).
    // That makes two warnings: the deprecation notice on 'inner-loop', and —
    // #2753 — 'outer' itself, whose only escalatable sink is an interactive
    // loop and therefore can't stop on a pause inside it.
    const pw = await discoveredWarnings([
      'nodes:',
      '  - id: outer',
      '    loop_group:',
      '      until_bash: "exit 0"',
      '      max_iterations: 2',
      '      nodes:',
      '        - id: inner-loop',
      '          loop:',
      '            prompt: work',
      '            until_bash: "exit 0"',
      '            max_iterations: 5',
      '            interactive: true',
      '            gate_message: continue?',
    ]);
    expect(pw).toHaveLength(2);
    expect(pw.some(w => w.includes("Node 'inner-loop'") && w.includes('interactive'))).toBe(true);
    expect(
      pw.some(w => w.includes("Node 'outer'") && w.includes('inner-loop') && w.includes('#2753'))
    ).toBe(true);
  });

  it('warns on a loop_group whose sole terminal sink is a gate-terminated nested loop_group (#2753)', async () => {
    const escalation = (
      await discoveredWarnings([
        'nodes:',
        '  - id: outer',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 2',
        '      nodes:',
        '        - id: inner',
        '          loop_group:',
        '            until_bash: test "$review.output.decision" = approve',
        '            max_iterations: 3',
        '            nodes:',
        '              - id: review',
        '                approval:',
        '                  message: ok?',
      ])
    ).filter(w => w.includes('#2753'));
    expect(escalation).toHaveLength(1);
    expect(escalation[0]).toContain("Node 'outer'");
    expect(escalation[0]).toContain("'inner'");
  });

  it('warns at every level of a 3-deep nested loop_group chain (#2753)', async () => {
    const escalation = (
      await discoveredWarnings([
        'nodes:',
        '  - id: grandparent',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 2',
        '      nodes:',
        '        - id: middle',
        '          loop_group:',
        '            until_bash: "exit 0"',
        '            max_iterations: 2',
        '            nodes:',
        '              - id: inner',
        '                loop_group:',
        '                  until_bash: test "$review.output.decision" = approve',
        '                  max_iterations: 3',
        '                  nodes:',
        '                    - id: review',
        '                      approval:',
        '                        message: ok?',
      ])
    ).filter(w => w.includes('#2753'));
    expect(escalation).toHaveLength(2);
    expect(escalation.some(w => w.includes("Node 'grandparent'") && w.includes("'middle'"))).toBe(
      true
    );
    expect(escalation.some(w => w.includes("Node 'middle'") && w.includes("'inner'"))).toBe(true);
  });

  it('does not warn when a nested loop_group has nothing interactive to escalate (#2753)', async () => {
    expect(
      await discoveredWarnings([
        'nodes:',
        '  - id: outer',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 2',
        '      nodes:',
        '        - id: inner',
        '          loop_group:',
        '            until_bash: "exit 0"',
        '            max_iterations: 3',
        '            nodes:',
        '              - id: work',
        '                prompt: do work',
      ])
    ).toEqual([]);
  });

  /**
   * The sink-shape checks judge the EXPANDED graph (#2756). An `include:` is a
   * legal loop_group body entry, so the shape these checks exist to catch can
   * arrive through composition — and pre-expansion there is nothing but an
   * unresolved include id to look at.
   */
  describe('include-composed sinks (#2756)', () => {
    /** Discover a parent plus a reusable block and return the PARENT's warnings. */
    const parentWarningsFor = async (parent: string[], block: string[]): Promise<string[]> => {
      const result = await discoverFiles(root(), {
        'parent.yaml': parent.join('\n'),
        'block.yaml': block.join('\n'),
      });
      expect(result.errors).toEqual([]);
      const found = result.workflows.find(w => w.workflow.name === 'parent');
      expect(found).toBeDefined();
      return [...(found?.parseWarnings ?? [])];
    };
    /** A parent whose loop_group body ends in `review`, an include of `target`. */
    const parentIncluding = (target: string, untilBash = '"exit 0"'): string[] => [
      'name: parent',
      'description: composes a block as the loop sink',
      'nodes:',
      '  - id: outer',
      '    loop_group:',
      `      until_bash: ${untilBash}`,
      '      max_iterations: 5',
      '      nodes:',
      '        - id: step-a',
      '          bash: "echo work"',
      '        - id: review',
      `          include: ${target}`,
      '          depends_on: [step-a]',
    ];
    const gateBlock = [
      'name: gate-block',
      'description: reusable approval',
      'nodes:',
      '  - id: check',
      '    approval:',
      '      message: ok?',
    ];

    it("warns when an include's own terminal sink makes it an unescalatable loop_group sink", async () => {
      const pw = await parentWarningsFor(parentIncluding('review-block'), [
        'name: review-block',
        'description: reusable interactive review',
        'nodes:',
        '  - id: iterate',
        '    loop_group:',
        '      interactive: true',
        '      gate_message: continue?',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: work',
        '          prompt: do work',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'outer'");
      expect(pw[0]).toContain("'review__iterate'");
      expect(pw[0]).toContain('#2753');
    });

    it("rejects an included gate that is not the expanded body's sole terminal sink", async () => {
      const result = await discoverFiles(root(), {
        'parent.yaml': [
          'name: parent',
          'description: composes a gate block mid-body',
          'nodes:',
          '  - id: outer',
          '    loop_group:',
          '      until_bash: "exit 0"',
          '      max_iterations: 5',
          '      nodes:',
          '        - id: review',
          '          include: gate-block',
          '        - id: after',
          '          depends_on: [review]',
          '          bash: "echo more work"',
        ].join('\n'),
        'block.yaml': gateBlock.join('\n'),
      });
      expect(result.workflows.some(w => w.workflow.name === 'parent')).toBe(false);
      expect(result.errors.find(e => e.filename === 'parent.yaml')?.error).toContain(
        "approval node 'review__check' must be the body's sole terminal sink"
      );
    });

    it("accepts a composed gate sink whose decision the group's until_bash reads", async () => {
      // The gate is the expanded body's sole terminal sink and 'until_bash' reaches it
      // through the include alias, which expansion rewrites to the namespaced id — the
      // completion-reference half of the #2707 step 3 check has to see it rewritten.
      expect(
        await parentWarningsFor(
          parentIncluding('gate-block', 'test "$review.output.decision" = approve'),
          gateBlock
        )
      ).toEqual([]);
    });

    it('does not warn when the composed sink has no pause to escalate', async () => {
      expect(
        await parentWarningsFor(parentIncluding('work-block'), [
          'name: work-block',
          'description: reusable deterministic work',
          'nodes:',
          '  - id: check',
          '    bash: "echo checked"',
        ])
      ).toEqual([]);
    });
  });

  it('rejects a gate node sharing terminal-sink status with another body node', () => {
    expect(
      parseError(
        workflowLines([
          'nodes:',
          '  - id: grp',
          '    loop_group:',
          '      until_bash: "exit 0"',
          '      max_iterations: 3',
          '      nodes:',
          '        - id: check',
          '          approval:',
          '            message: ok?',
          '        - id: also-terminal',
          '          prompt: an independent branch',
        ])
      )
    ).toContain(
      "loop_group 'grp' body: approval node 'check' must be the body's sole terminal sink"
    );
  });

  it('warns on the prose until: channel on a loop node', () => {
    const pw = parsedWarnings([
      'nodes:',
      '  - id: iterate',
      '    loop:',
      '      prompt: work',
      '      until: DONE',
      '      max_iterations: 5',
    ]);
    expect(pw).toHaveLength(1);
    expect(pw[0]).toContain(
      "Node 'iterate': the prose 'loop.until' completion signal is deprecated"
    );
    expect(pw[0]).toContain('until_bash');
    expect(pw[0]).toContain('until_field');
    expect(pw[0]).toContain('<promise>SIGNAL</promise>');
    expect(pw[0]).toContain('final standalone signal line');
  });

  it('warns on the prose until: channel on a loop_group node, with loop_group-specific guidance (no until_field)', async () => {
    const pw = await discoveredWarnings([
      'nodes:',
      '  - id: grp',
      '    loop_group:',
      '      until: DONE',
      '      max_iterations: 3',
      '      nodes:',
      '        - id: work',
      '          prompt: do work',
    ]);
    expect(pw).toHaveLength(1);
    expect(pw[0]).toContain(
      "Node 'grp': the prose 'loop_group.until' completion signal is deprecated"
    );
    expect(pw[0]).toContain('loop_group.until_bash');
    expect(pw[0]).not.toContain('until_field');
    expect(pw[0]).toContain('<promise>SIGNAL</promise>');
    expect(pw[0]).toContain('final standalone signal line');
  });

  it('does NOT warn on until_bash or until_field alone', async () => {
    expect(
      await discoveredWarnings([
        'nodes:',
        '  - id: iterate',
        '    loop:',
        '      prompt: work',
        '      until_bash: "exit 0"',
        '      max_iterations: 5',
        '  - id: grp',
        '    depends_on: [iterate]',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: work',
        '          prompt: do work',
      ])
    ).toEqual([]);
  });

  it('warns on a typo inside a decisions: entry (R5 fix — array typo protection)', () => {
    const pw = parsedWarnings([
      'nodes:',
      '  - id: gate',
      '    approval:',
      '      message: ok?',
      '      decisions:',
      '        - id: approve',
      '        - id: reject',
      '          lable: Needs work', // typo for 'label'
    ]);
    expect(pw.some(w => w.includes("unknown key 'approval.decisions.1.lable'"))).toBe(true);
  });
});
