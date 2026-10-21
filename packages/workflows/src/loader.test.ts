// @archon-test-isolated
import {
  discoverFiles,
  expectRejected,
  inlinePrompt,
  mockLogger,
  nodeWith,
  parseError,
  parseWorkflow,
  parseWorkflowYaml,
  useTempWorkflowRoot,
  writeWorkflowFile,
} from './loader/test-utils';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import {
  isAgentNode,
  isExecNode,
  isHaltNode,
  isLoopGroupNode,
  isLoopNode,
  type DagNode,
} from './schemas';
import { parseWorkflow as parseWorkflowWithProviders } from './loader';
import { COMPILED_LOOP_COMMAND, type LoopWithCompiledCommand } from './compiled-command';

/** A workflow named `name` whose `nodes:` list is the given YAML lines. */
const withNodes = (nodes: string, name = 'test'): string =>
  `name: ${name}\ndescription: test\nnodes:\n${nodes}`;

/** The parsed nodes of a workflow that must load. */
const parsedNodes = (yaml: string): DagNode[] =>
  parseWorkflowYaml(yaml).workflow.nodes as DagNode[];

describe('workflow YAML line endings', () => {
  it.each(['"', "'"])('folds multiline %s-quoted prompts identically for LF and CRLF', quote => {
    const lf = `name: line-endings
description: Quoted multiline scalar
nodes:
  - id: read
    prompt: ${quote}first line
      second line${quote}
`;
    const { workflow: lfWorkflow } = parseWorkflowYaml(lf);
    const { workflow: crlfWorkflow } = parseWorkflowYaml(lf.replaceAll('\n', '\r\n'));

    expect(inlinePrompt(lfWorkflow.nodes[0])).toBe('first line second line');
    expect(crlfWorkflow).toEqual(lfWorkflow);
  });
});

describe('parseWorkflow', () => {
  it.each(['true', 'false', '"yes"'])(
    'loads workflow-level interactive: %s with a deprecation warning and drops it',
    value => {
      const { workflow, warnings } = parseWorkflowYaml(
        `name: test\ndescription: test\ninteractive: ${value}\nnodes:\n  - id: n\n    prompt: p\n`
      );
      expect('interactive' in workflow).toBe(false);
      expect(warnings).toEqual([
        "Workflow 'test': workflow-level 'interactive:' is deprecated and has no effect. " +
          'Any workflow can start in the foreground, in the background or from a trigger; a ' +
          'pause waits in the attention queue until it is answered. Remove the line.',
      ]);
    }
  );

  it('should parse valid DAG workflow YAML', () => {
    const { workflow } = parseWorkflowYaml(`name: test-workflow
description: A test workflow
provider: claude
nodes:
  - id: plan
    command: plan
  - id: implement
    command: implement
    depends_on: [plan]
`);

    expect(workflow.name).toBe('test-workflow');
    expect(workflow.description).toBe('A test workflow');
    expect(workflow.provider).toBe('claude');
    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.nodes[0].id).toBe('plan');
    expect(workflow.nodes[1].id).toBe('implement');
  });

  it.each(
    ['[one]', '[]', '{}', 'null', 'legacy', '0', 'false'].flatMap(steps =>
      [false, true].map(hasNodes => [steps, hasNodes] as const)
    )
  )(
    'rejects steps: %s with nodes present: %s and provides migration guidance',
    (steps, hasNodes) => {
      const result = parseWorkflow(
        `name: legacy-workflow
description: Uses deprecated steps format
steps: ${steps}
${hasNodes ? 'nodes:\n  - id: work\n    prompt: work\n' : ''}`,
        'legacy.yaml'
      );
      expect(result.workflow).toBeNull();
      expect(result.error?.errorType).toBe('validation_error');
      expect(result.error?.error).toContain('steps:');
      expect(result.error?.error).toContain('has been removed');
      expect(result.error?.error).toContain('nodes:');
      expect(result.error?.error).toContain('https://archon.diy/reference/workflow-language/');
      expect(result.error?.error).not.toContain('docs/sequential-dag-migration-guide.md');
      expect(result.error?.error).not.toContain('claude');
    }
  );

  it('should reject unknown provider at load time', () => {
    const result = parseWorkflow(
      `name: invalid-provider
description: Invalid provider specified
provider: claud
nodes:
  - id: test
    command: test
`,
      'test.yaml'
    );
    expect(result.workflow).toBeNull();
    expect(result.error?.errorType).toBe('validation_error');
    expect(result.error?.error).toContain("Unknown provider: 'claud'");
  });

  it.each([
    ['', 'thinking: enabled\n', '    prompt: p\n'],
    [' on a node', '', '    prompt: p\n    thinking: adaptive\n'],
  ])('should reject retired thinking config%s and name effort', (_, workflowLevel, node) => {
    const result = parseWorkflow(
      `name: retired-thinking\ndescription: retired option\n${workflowLevel}nodes:\n  - id: only\n${node}`,
      'retired.yaml'
    );
    expect(result.workflow).toBeNull();
    expect(result.error?.errorType).toBe('validation_error');
    expect(result.error?.error).toContain('effort:');
  });

  it('should accept the widened effort ladder on NODES, not just at workflow level', () => {
    // `effortLevelSchema` backs both the workflow field and the node field, but
    // only the workflow one was proven against real YAML. The node field is the
    // headline of #2556 — "effort: works per node on every provider" — and it
    // crosses `dagNodeSchema.safeParse()`, a boundary no other effort test
    // touches (the executor and provider suites build objects in memory).
    // Narrowing the node enum would pass every one of those and fail the WHOLE
    // workflow to load, not just the field.
    const { workflow, warnings } = parseWorkflowYaml(`name: node-effort-rungs
description: Node-level effort across the full ladder
provider: codex
nodes:
  - id: shallow
    command: test
    effort: minimal
  - id: deep
    command: test
    effort: xhigh
    depends_on: [shallow]
`);
    const nodes = workflow.nodes as DagNode[];
    expect(nodes.find(n => n.id === 'shallow')?.effort).toBe('minimal');
    expect(nodes.find(n => n.id === 'deep')?.effort).toBe('xhigh');
    expect(warnings).toEqual([]);
  });

  // Node-level declaration (#2771): the engine-enforced tree-integrity assertion.
  it('should parse node-level mutates_checkout onto exec and agent nodes', () => {
    const { workflow } = parseWorkflowYaml(`name: test-workflow
description: node-level declarations
nodes:
  - id: guarded-bash
    bash: echo hi
    mutates_checkout: false
  - id: guarded-agent
    prompt: p
    mutates_checkout: false
  - id: plain
    bash: echo hi
`);
    const byId = Object.fromEntries(workflow.nodes.map(n => [n.id, n]));
    const guardedBash = byId['guarded-bash'];
    expect(
      guardedBash && 'mutates_checkout' in guardedBash && guardedBash.mutates_checkout === false
    ).toBe(true);
    const guardedAgent = byId['guarded-agent'];
    expect(
      guardedAgent && 'mutates_checkout' in guardedAgent && guardedAgent.mutates_checkout === false
    ).toBe(true);
    const plain = byId['plain'];
    expect(plain && !('mutates_checkout' in plain)).toBe(true);
  });

  it('should reject a non-boolean node-level mutates_checkout', () => {
    const result = parseWorkflow(
      withNodes('  - id: n\n    bash: echo hi\n    mutates_checkout: "no"\n'),
      'bad.yaml'
    );
    expect(result.error).not.toBeNull();
  });

  it("rejects 'mutates_checkout' on an include node, naming workflow level and workflow:", () => {
    // The one launch-only option the schema cannot see — it is workflow-level, so Zod
    // strips it before superRefine runs (#1764 Task 8).
    const error = parseError(
      withNodes('  - id: sub\n    include: mc-block\n    mutates_checkout: false\n', 'mc-parent')
    );
    expect(error).toContain("'mutates_checkout' is not supported on an include node");
    expect(error).toContain("'workflow:' node");
  });

  it("rejects a node-level 'mutates_checkout' on a composed fan-out", () => {
    const error = parseError(
      withNodes(
        `  - id: items\n    bash: 'echo ["a"]'\n  - id: fan\n    include: mc-fan-block\n    depends_on: [items]\n    mutates_checkout: false\n    fan_out:\n      items: "$items.output"\n      as: item\n`,
        'mc-fan-parent'
      )
    );
    expect(error).toContain('share its checkout');
    expect(error).toContain('fan_out.max_parallel: 1');
  });

  it('should warn that mutates_checkout is inert on loop/gate/cancel/loop_group nodes', () => {
    mockLogger.warn.mockClear();
    for (const [nodeYaml, kind] of [
      ['    loop:\n      until: done\n      max_iterations: 1\n      prompt: p', 'loop'],
      ['    approval:\n      message: m', 'approval'],
      ['    cancel: stop', 'cancel'],
      [
        '    loop_group:\n      nodes:\n        - id: b\n          bash: echo hi\n      until: done\n      max_iterations: 1',
        'loop_group',
      ],
    ] as const) {
      const result = parseWorkflow(
        `name: mc-inert-${kind}
description: d
nodes:
  - id: n
${nodeYaml}
    mutates_checkout: false
`,
        `${kind}-mc.yaml`
      );
      expect(result.error).toBeNull();
      expect(
        result.warnings?.some(w => w.includes("'mutates_checkout'") && w.includes(`(${kind})`))
      ).toBe(true);
    }
  });
});

describe('command name validation (Issue #129)', () => {
  it.each(['../../../etc/passwd', '.hidden'])('should reject a DAG command named %s', name => {
    expect(parseError(withNodes(`  - id: bad\n    command: ${name}\n`))).toContain(
      `invalid command name "${name}"`
    );
  });

  it('should accept valid command names in DAG nodes', () => {
    const nodes = parsedNodes(`name: valid-commands
description: Has valid command names
nodes:
  - id: plan
    command: plan
  - id: implement
    command: implement
    depends_on: [plan]
  - id: review
    command: review-pr
    depends_on: [implement]
`);
    expect(nodes).toHaveLength(3);
  });
});

describe('edge cases', () => {
  it.each([
    ['missing nodes field', 'name: no-nodes\ndescription: Missing nodes\n', "'nodes:'"],
    [
      'null description',
      'name: null-test\ndescription: ~\nnodes:\n  - id: test\n    command: test\n',
      "'description'",
    ],
  ])('should reject a workflow with a %s', (_, yaml, message) => {
    expect(parseError(yaml)).toContain(message);
  });

  it('parses always_run: true on a node', () => {
    const nodes = parsedNodes(`name: always-run-test
description: Producer opts out of resume caching
nodes:
  - id: persist
    bash: 'echo hi'
    always_run: true
  - id: consumer
    command: consume
    depends_on: [persist]
`);
    expect(nodes[0].id).toBe('persist');
    expect(nodes[0].always_run).toBe(true);
    expect(nodes[1].always_run).toBeUndefined();
  });

  it('preserves an optional description on a node', () => {
    const nodes = parsedNodes(`name: node-description-test
description: Node-level description is kept, not stripped
nodes:
  - id: documented
    bash: 'echo hi'
    description: Runs the full security gate against the target repo
  - id: undocumented
    bash: 'echo bye'
    depends_on: [documented]
`);
    expect(nodes[0].description).toBe('Runs the full security gate against the target repo');
    expect(nodes[1].description).toBeUndefined();
  });
});

describe('bash node parsing', () => {
  /** The debug lines a parse logged for AI-only fields a node kind ignores. */
  const ignoredFieldLogs = () =>
    mockLogger.debug.mock.calls.filter(
      call => typeof call[1] === 'string' && call[1].includes('ai_fields_ignored')
    );

  it('should parse a valid bash node', () => {
    const nodes = parsedNodes(`
name: bash-test
description: Test bash node
nodes:
  - id: stats
    bash: "echo hello"
  - id: process
    command: my-cmd
    depends_on: [stats]
`);
    expect(nodes).toHaveLength(2);
    const node0 = nodes[0];
    expect(isExecNode(node0)).toBe(true);
    if (isExecNode(node0)) {
      expect(node0.script).toBe('echo hello');
    }
  });

  it('should parse bash node with timeout', () => {
    const node0 = parsedNodes(
      withNodes('  - id: slow\n    bash: "sleep 1 && echo done"\n    timeout: 30000\n')
    )[0];
    expect(isExecNode(node0)).toBe(true);
    if (isExecNode(node0)) {
      expect(node0.timeout).toBe(30000);
    }
  });

  it('should preserve on_timeout on bash and script nodes', () => {
    expect(
      parsedNodes(`
name: exec-timeout-skip
description: Exec nodes can skip on timeout
nodes:
  - id: shell
    bash: "sleep 30"
    timeout: 100
    on_timeout: skip
  - id: program
    script: "await Bun.sleep(30_000)"
    runtime: bun
    timeout: 100
    on_timeout: skip
`)
    ).toEqual([
      expect.objectContaining({ id: 'shell', on_timeout: 'skip' }),
      expect.objectContaining({ id: 'program', on_timeout: 'skip' }),
    ]);
  });

  it('rejects on_timeout on a non-exec node', () => {
    expect(
      parseError(withNodes('  - id: prompt\n    prompt: "work"\n    on_timeout: skip\n'))
    ).toBe(
      "DAG node validation failed: Node 'prompt': 'on_timeout' is only supported on bash or script nodes, not on prompt nodes."
    );
  });

  it.each([
    [
      '  - id: a\n    prompt: work\n    timeout: 5\n',
      "Node 'a': 'timeout' is only supported on bash, loop, loop_group or script nodes, not on prompt nodes.",
    ],
    [
      '  - id: a\n    include: block\n    isolation: worktree\n',
      "Node 'a': 'isolation' is not supported on an include node: a composed block runs inside the run that composed it, so it has no checkout of its own to isolate. Use a 'workflow:' node instead when you want a separate governed run.",
    ],
    [
      '  - id: a\n    include: block\n    input: work\n',
      "Node 'a': 'input' is not supported on an include node: a composed block reads named values as $INPUTS.<name>, supplied through 'with:' — there is no separate $ARGUMENTS for it. Use a 'workflow:' node instead when you want a separate governed run.",
    ],
    [
      '  - id: a\n    prompt: work\n    until_bash: true\n',
      "Node 'a': 'until_bash' is only honoured inside 'loop:' or 'loop_group:'; at the top level nothing reads it.",
    ],
    [
      '  - id: outer\n    loop_group:\n      until: DONE\n      max_iterations: 1\n      nodes:\n        - id: inner\n          prompt: work\n          runtime: bun\n',
      "Node 'inner': 'loop_group.nodes.0.runtime' is only supported on script nodes, not on prompt nodes.",
    ],
    [
      '  - id: outer\n    loop_group:\n      until: DONE\n      max_iterations: 1\n      nodes:\n        - id: inner\n          prompt: work\n          until_bash: true\n',
      "Node 'inner': 'loop_group.nodes.0.until_bash' is only honoured inside 'loop:' or 'loop_group:'; at the top level nothing reads it.",
    ],
  ])('formats wrong-key context once for %s', (nodes, expected) => {
    expect(parseError(withNodes(nodes))).toBe(`DAG node validation failed: ${expected}`);
  });

  it.each<[string, string, RegExp]>([
    [
      'bash + command combination',
      '    bash: "echo hi"\n    command: my-cmd',
      /mutually exclusive/i,
    ],
    [
      'bash + prompt combination',
      '    bash: "echo hi"\n    prompt: "do something"',
      /mutually exclusive/i,
    ],
    ['invalid timeout (negative)', '    bash: "echo hi"\n    timeout: -1', /timeout.*positive/i],
    ['invalid timeout (string)', '    bash: "echo hi"\n    timeout: "fast"', /timeout/i],
    [
      'invalid idle_timeout (negative)',
      '    command: my-cmd\n    idle_timeout: -1',
      /idle_timeout.*positive/i,
    ],
    [
      'invalid idle_timeout (string)',
      '    prompt: "do something"\n    idle_timeout: "slow"',
      /idle_timeout/i,
    ],
    // zod v4's base `z.number()` rejects Infinity before the custom finite/positive
    // refinement runs, so the message is the base "expected number" form; either is fine.
    [
      'invalid idle_timeout (Infinity)',
      '    prompt: "do something"\n    idle_timeout: .inf',
      /idle_timeout.*(finite.*positive|expected number)/i,
    ],
  ])('should reject %s', (_, fields, message) => {
    expect(parseError(withNodes(`  - id: bad\n${fields}\n`))).toMatch(message);
  });

  it.each<[string, string, number, (node: DagNode) => boolean]>([
    ['command', '    command: my-cmd', 1800000, isAgentNode],
    ['prompt', '    prompt: "do something slow"', 600000, isAgentNode],
    ['bash', '    bash: "sleep 100"', 900000, isExecNode],
  ])('should parse idle_timeout on a %s node', (_, source, idleTimeout, isKind) => {
    const node = parsedNodes(
      withNodes(`  - id: long-running\n${source}\n    idle_timeout: ${idleTimeout}\n`)
    )[0];
    expect(isKind(node)).toBe(true);
    expect(node.idle_timeout).toBe(idleTimeout);
  });

  it('should ignore AI-specific fields on bash nodes (parses successfully, fields stripped)', () => {
    // Should parse successfully (warning only, not error)
    const node = parsedNodes(
      withNodes('  - id: stats\n    bash: "wc -l *.ts"\n    provider: claude\n    model: haiku\n')
    )[0];
    // AI fields should NOT appear on the parsed bash node
    expect(isExecNode(node)).toBe(true);
    expect(node.provider).toBeUndefined();
    expect(node.model).toBeUndefined();
  });

  it('should NOT warn about model/provider on loop nodes (they are supported)', () => {
    mockLogger.debug.mockClear();
    const node = parsedNodes(`
name: loop-model
description: Loop with model override
nodes:
  - id: iterate
    loop:
      prompt: "Do something"
      until: "COMPLETE"
      max_iterations: 3
    provider: claude
    model: claude-opus-4-6
`)[0];
    expect(isLoopNode(node)).toBe(true);
    expect(ignoredFieldLogs()).toHaveLength(0);
  });

  it('should warn about unsupported AI fields on loop nodes (not model/provider)', () => {
    mockLogger.debug.mockClear();
    parseWorkflowYaml(`
name: loop-unsupported
description: Loop with unsupported AI fields
nodes:
  - id: iterate
    loop:
      prompt: "Do something"
      until: "COMPLETE"
      max_iterations: 3
    model: claude-opus-4-6
    mcp: ./mcp.json
`);

    // Should warn about mcp but NOT about model
    const aiFieldWarnings = ignoredFieldLogs();
    expect(aiFieldWarnings).toHaveLength(1);
    const warnedFields = (aiFieldWarnings[0][0] as { fields: string[] }).fields;
    expect(warnedFields).toContain('mcp');
    expect(warnedFields).not.toContain('model');
    expect(warnedFields).not.toContain('provider');
  });

  it('should NOT warn about output_format on a loop node (#2563)', () => {
    // A loop: node makes its own sendQuery, so the schema is honoured rather than
    // warned-and-dropped. It stays warned on loop_group, which never calls sendQuery.
    mockLogger.debug.mockClear();
    const node0 = parsedNodes(`
name: loop-structured
description: Loop with a structured completion channel
nodes:
  - id: iterate
    output_format:
      type: object
      properties:
        done:
          type: boolean
      required: [done]
    loop:
      prompt: "Do something"
      max_iterations: 3
      until_field: done
`)[0];
    expect(ignoredFieldLogs()).toHaveLength(0);
    expect(isLoopNode(node0)).toBe(true);
    if (isLoopNode(node0)) {
      expect(node0.loop.until_field).toBe('done');
      expect(node0.output_format).toBeDefined();
    }
  });

  it('warns that output_format is ignored on a loop_group', () => {
    mockLogger.debug.mockClear();
    const node = parsedNodes(`
name: loop-group-structured
description: Group with an unsupported structured output declaration
nodes:
  - id: iterate
    provider: claude
    model: claude-opus-4-6
    output_format:
      type: object
      properties:
        done:
          type: boolean
      required: [done]
    loop_group:
      until_bash: exit 0
      max_iterations: 1
      nodes:
        - id: work
          bash: echo done
`)[0];
    expect(isLoopGroupNode(node)).toBe(true);

    const aiFieldWarnings = ignoredFieldLogs();
    expect(aiFieldWarnings).toHaveLength(1);
    const warnedFields = (aiFieldWarnings[0][0] as { fields: string[] }).fields;
    expect(warnedFields).toContain('output_format');
    expect(warnedFields).not.toContain('model');
    expect(warnedFields).not.toContain('provider');
  });

  it('does NOT warn about output_format on bash/script nodes, and keeps it (#2453)', () => {
    // An exec node with a declared schema certifies its own stdout, so the field is
    // enforced rather than warned-and-dropped — and it has to survive the transform to
    // reach that enforcement. `mcp:` on the same node still warns: nothing else changed.
    mockLogger.debug.mockClear();
    const nodes = parsedNodes(`
name: exec-contract
description: Deterministic producers own a result contract
nodes:
  - id: shell
    bash: echo '{"ready":true}'
    output_format:
      type: object
      properties:
        ready:
          type: boolean
      required: [ready]
  - id: prog
    runtime: bun
    script: console.log('{"ready":true}')
    mcp: ./mcp.json
    output_format:
      type: object
      properties:
        ready:
          type: boolean
      required: [ready]
`);

    const warnedFields = ignoredFieldLogs().flatMap(
      call => (call[0] as { fields: string[] }).fields
    );
    expect(warnedFields).not.toContain('output_format');
    expect(warnedFields).toContain('mcp');

    for (const node of nodes) {
      expect(isExecNode(node)).toBe(true);
      expect(node.output_format).toEqual({
        type: 'object',
        properties: { ready: { type: 'boolean' } },
        required: ['ready'],
      });
    }
  });

  it('should NOT warn about pi: on loop nodes and should preserve it (#2133)', () => {
    // The portable pi: posture is threaded into each loop iteration's sendQuery,
    // so it must survive the transform AND not be flagged as an ignored AI field.
    // No workflow-level provider: the pi: block is plain node data the loader
    // preserves regardless of provider.
    mockLogger.debug.mockClear();
    const node = parsedNodes(`
name: loop-pi
description: Loop with per-node Pi posture
nodes:
  - id: implement
    loop:
      prompt: "Do something"
      until: "COMPLETE"
      max_iterations: 3
    pi:
      interactive: false
      extensionFlags:
        plan: false
`)[0];
    expect(isLoopNode(node)).toBe(true);
    expect((node as typeof node & { pi?: unknown }).pi).toEqual({
      interactive: false,
      extensionFlags: { plan: false },
    });
    expect(ignoredFieldLogs()).toHaveLength(0);
  });

  it('should NOT warn about tool restrictions on a loop node and should preserve them (#3324)', () => {
    // A loop: node scopes its own per-iteration sendQuery, so the restriction has to
    // survive the transform. Dropping it was fail-open: there is no workflow-level
    // allowed_tools/denied_tools for the node to fall back on.
    mockLogger.debug.mockClear();
    const { workflow, warnings } = parseWorkflowYaml(`
name: loop-denied
description: Loop that must not reach the network
nodes:
  - id: work
    denied_tools: [WebFetch, WebSearch]
    allowed_tools: [Read, Grep]
    loop:
      prompt: "Do something"
      until_bash: "true"
      max_iterations: 3
`);
    const node = workflow.nodes[0] as DagNode;
    expect(isLoopNode(node)).toBe(true);
    expect(node.denied_tools).toEqual(['WebFetch', 'WebSearch']);
    expect(node.allowed_tools).toEqual(['Read', 'Grep']);
    expect(ignoredFieldLogs()).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('reports an ignored AI field to the author, not only to the log (#3324)', () => {
    // The defect this closes: the drop was announced by a pino line alone, which
    // neither `archon validate workflows` nor `archon workflow list` renders — both
    // read parseWarnings. A field the engine drops has to appear in that list.
    mockLogger.debug.mockClear();
    const { warnings } = parseWorkflowYaml(`
name: loop-ignored-fields
description: Loop declaring fields the engine drops
nodes:
  - id: work
    mcp: ./mcp.json
    skills: [code-review]
    loop:
      prompt: "Do something"
      until_bash: "true"
      max_iterations: 3
`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Node 'work'");
    expect(warnings[0]).toContain("'mcp'");
    expect(warnings[0]).toContain("'skills'");
    expect(warnings[0]).toContain('ignored at run time');

    // The structured log line keeps its payload and now carries the same prose.
    const aiFieldWarnings = ignoredFieldLogs();
    expect(aiFieldWarnings).toHaveLength(1);
    const logged = aiFieldWarnings[0][0] as { fields: string[]; warning: string };
    expect(logged.fields).toEqual(['mcp', 'skills']);
    expect(logged.warning).toBe(warnings[0]);
  });

  it('reports ignored AI fields on a non-AI node to the author too (#3324)', () => {
    // Same routing for every node kind with an ignored-field list — a bash node is
    // where an author is most likely to declare a restriction that does nothing.
    const { warnings } = parseWorkflowYaml(
      withNodes('  - id: check\n    bash: echo hi\n    denied_tools: [WebFetch]\n')
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'denied_tools'");
    expect(warnings[0]).toContain('(bash)');
  });

  describe('through include expansion', () => {
    const root = useTempWorkflowRoot();

    it("warns, operator-visibly, that an include's denied_tools is dropped rather than enforced", async () => {
      // The real bug behind #3196: a caller sandboxing a block it did not write got no
      // signal that its restriction never attached. A log line only an operator tailing
      // server output can see is not enough; this must land in `parseWarnings`, the
      // channel the workflow's actual author reads via `/api/workflows` and `/workflow
      // list` (#2213).
      mockLogger.debug.mockClear();
      const result = await discoverFiles(root(), {
        'block.yaml': `
name: block
description: An included building block
nodes:
  - id: build
    prompt: "do the work"
`,
        'include-denied-tools.yaml': `
name: include-denied-tools
description: A caller trying to sandbox a block it did not write
nodes:
  - id: use
    include: block
    denied_tools: ["Bash(rm:*)"]
`,
      });
      expect(result.errors).toHaveLength(0);

      const parent = result.workflows.find(w => w.workflow.name === 'include-denied-tools');
      const pw = parent?.parseWarnings ?? [];
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'use'");
      expect(pw[0]).toContain("'denied_tools'");
      expect(pw[0]).toContain('an include attaches a sub-graph and does not reconfigure it');

      // The included block's own node is unrestricted: the caller's denial never applied.
      const expandedNode = (parent?.workflow.nodes as DagNode[]).find(n => n.id === 'use__build');
      expect(expandedNode).toBeDefined();
      expect(expandedNode?.denied_tools).toBeUndefined();

      const aiFieldWarnings = ignoredFieldLogs();
      expect(aiFieldWarnings).toHaveLength(1);
      expect(aiFieldWarnings[0][0]).toMatchObject({ fields: ['denied_tools'], warning: pw[0] });
    });
  });
});

describe('retry config parsing', () => {
  it.each<[string, string, DagNode['retry'], (node: DagNode) => boolean]>([
    [
      'command',
      '    command: sync-cmd\n    retry:\n      max_attempts: 2',
      { max_attempts: 2 },
      isAgentNode,
    ],
    [
      'bash',
      '    bash: "npm run deploy"\n    retry:\n      max_attempts: 1\n      delay_ms: 2000\n      on_error: all',
      { max_attempts: 1, delay_ms: 2000, on_error: 'all' },
      isExecNode,
    ],
    [
      'prompt',
      '    prompt: "Summarise the changes"\n    retry:\n      max_attempts: 2\n      delay_ms: 4000\n      on_error: transient',
      { max_attempts: 2, delay_ms: 4000, on_error: 'transient' },
      isAgentNode,
    ],
  ])('should parse retry config on a DAG %s node', (_, fields, retry, isKind) => {
    const node = parsedNodes(withNodes(`  - id: n\n${fields}\n`))[0];
    expect(isKind(node)).toBe(true);
    expect(node.retry).toEqual(retry);
  });

  it('loads zero-delay retry config on a loop without warnings', () => {
    const { workflow, warnings } = parseWorkflowYaml(`
name: retry-loop
description: Loop iteration retry
nodes:
  - id: work
    retry:
      max_attempts: 1
      delay_ms: 0
    loop:
      prompt: Work
      until_bash: "true"
      max_iterations: 2
`);
    expect((workflow.nodes[0] as DagNode).retry).toEqual({ max_attempts: 1, delay_ms: 0 });
    expect(warnings).toEqual([]);
  });

  it.each<[string, string, RegExp]>([
    // zod v4 reports a missing required field as "expected number, received undefined"
    // (v3 said "Required"); the field path is the stable part.
    ['missing max_attempts', 'delay_ms: 5000', /max_attempts.*(required|expected number)/i],
    ['max_attempts out of range', 'max_attempts: 10', /max_attempts.*between 1 and 5/i],
    [
      'an invalid on_error value',
      'max_attempts: 2\n      on_error: always',
      /on_error.*transient.*all/i,
    ],
    ['delay_ms out of range', 'max_attempts: 2\n      delay_ms: 100', /delay_ms.*1000.*60000/i],
  ])('should reject retry with %s', (_, retry, message) => {
    expect(
      parseError(withNodes(`  - id: my-cmd\n    command: my-cmd\n    retry:\n      ${retry}\n`))
    ).toMatch(message);
  });
});

describe('loop node parsing', () => {
  /** The single node of a workflow that must load, asserted to be a loop node. */
  const loopNode = (yaml: string) => {
    const node = parsedNodes(yaml)[0];
    if (!isLoopNode(node)) throw new Error('expected a loop node');
    return node;
  };

  it('should parse a valid loop node with all fields', () => {
    const node0 = loopNode(`
name: loop-test
description: Test loop node
nodes:
  - id: my-loop
    loop:
      prompt: "Do one task. Output <promise>COMPLETE</promise> when done."
      until: COMPLETE
      max_iterations: 10
      fresh_context: true
      until_bash: "test -f done.txt"
    idle_timeout: 300000
`);
    expect(node0.loop.prompt).toContain('Do one task');
    expect(node0.loop.until).toBe('COMPLETE');
    expect(node0.loop.max_iterations).toBe(10);
    expect(node0.loop.fresh_context).toBe(true);
    expect(node0.loop.until_bash).toBe('test -f done.txt');
    expect(node0.idle_timeout).toBe(300000);
  });

  it('should parse minimal loop node (only required fields)', () => {
    const node0 = loopNode(
      withNodes(
        '  - id: simple-loop\n    loop:\n      prompt: "Iterate."\n      until: DONE\n      max_iterations: 3\n'
      )
    );
    expect(node0.loop.fresh_context).toBe(false);
    expect(node0.loop.until_bash).toBeUndefined();
  });

  it('should load a loop node that declares only until_bash (#2563)', () => {
    const node0 = loopNode(`
name: loop-deterministic
description: Deterministic completion, no prose sentinel
nodes:
  - id: fix
    loop:
      prompt: "Fix the failing tests"
      max_iterations: 5
      until_bash: "bun run test"
`);
    expect(node0.loop.until).toBeUndefined();
    expect(node0.loop.until_bash).toBe('bun run test');
  });

  it('should parse loop node with depends_on', () => {
    const nodes = parsedNodes(`
name: loop-deps
description: Loop with dependencies
nodes:
  - id: setup
    bash: "echo ready"
  - id: my-loop
    depends_on: [setup]
    loop:
      prompt: "Use $setup.output. Do task."
      until: COMPLETE
      max_iterations: 5
`);
    expect(nodes).toHaveLength(2);
    expect(isLoopNode(nodes[1])).toBe(true);
    expect(nodes[1].depends_on).toEqual(['setup']);
  });

  it('should accept interactive loop with gate_message', () => {
    const node0 = loopNode(`
name: valid-interactive
description: Valid interactive loop
nodes:
  - id: my-loop
    loop:
      prompt: Do something.
      until: DONE
      max_iterations: 5
      interactive: true
      gate_message: Review and respond.
`);
    expect(node0.loop.interactive).toBe(true);
    expect(node0.loop.gate_message).toBe('Review and respond.');
  });

  // loop.command is an alternative to loop.prompt that loads the iteration prompt
  // from a command file. The loader only enforces the "exactly one" rule and the
  // command-name safety rule; file resolution is validator-level and is covered
  // separately in validator.test.ts.
  it('should parse a loop node with loop.command (no inline prompt)', () => {
    const node = loopNode(
      withNodes(
        '  - id: my-loop\n    loop:\n      command: my-loop-cmd\n      until: COMPLETE\n      max_iterations: 5\n'
      )
    );
    expect(node.loop.command).toBe('my-loop-cmd');
    expect(node.loop.prompt).toBeUndefined();
  });

  it('should trim surrounding whitespace from loop.command so resolution sees the normalized name', () => {
    // Parsing NORMALIZES the command name (schema-level trim) rather than
    // rejecting it: a quoted YAML value like `" my-loop-cmd "` (or one with a
    // stray trailing newline from awkward block scalars) is stored trimmed,
    // so downstream `loadCommandPrompt` — which resolves the literal filename
    // — sees the same name the author meant instead of failing at runtime
    // with a confusing "not found".
    const node = loopNode(
      withNodes(
        '  - id: my-loop\n    loop:\n      command: "  my-loop-cmd  "\n      until: DONE\n      max_iterations: 3\n'
      )
    );
    expect(node.loop.command).toBe('my-loop-cmd');
  });

  it('should not false-positive the $nodeId.output ref scan on a command-backed loop with a sibling that consumes its output', () => {
    // The ref scan skips a loop with no inline prompt: it must (a) not crash trying
    // to read the missing prompt, and (b) still register the loop's id so a sibling
    // can reference `$my-loop.output` like any other node output.
    const nodes = parsedNodes(`
name: loop-cmd-with-sibling
description: Command-backed loop with a downstream consumer
nodes:
  - id: my-loop
    loop:
      command: my-loop-cmd
      until: DONE
      max_iterations: 3
  - id: consumer
    depends_on: [my-loop]
    prompt: "Process the loop output: $my-loop.output"
`);
    expect(nodes).toHaveLength(2);
  });

  it.each([
    [
      'a loop with signal_completes',
      `  - id: validate
    loop:
      prompt: Validate.
      until: VALIDATED
      max_iterations: 5
      interactive: true
      gate_message: Review.
      signal_completes: true
`,
    ],
    [
      'a well-formed loop_group',
      `  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: work
          prompt: "do work"
          depends_on: []
`,
    ],
    [
      'a loop_group until_bash referencing a direct body output',
      `  - id: group
    loop_group:
      until_bash: "test $ready-flag.output = ready"
      max_iterations: 2
      nodes:
        - id: ready-flag
          bash: "echo ready"
`,
    ],
    [
      'a body prompt referencing an outer-DAG node via $nodeId.output',
      `  - id: setup
    bash: "echo hi"
  - id: grp
    depends_on: [setup]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: work
          prompt: "Use this context: $setup.output"
`,
    ],
  ])('should accept %s', (_, nodes) => {
    parseWorkflowYaml(withNodes(nodes));
  });

  it('should warn (non-blocking) when signal_completes is set without interactive', () => {
    // Workflow loads successfully — this is a warning, not an error
    parseWorkflowYaml(
      withNodes(
        '  - id: validate\n    loop:\n      prompt: Validate.\n      until: VALIDATED\n      max_iterations: 5\n      signal_completes: true\n'
      ),
      'sc-no-interactive.yaml'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filename: expect.stringContaining('sc-no-interactive') }),
      'signal_completes_without_interactive_ignored'
    );
  });

  it.each<[string, string, string[]]>([
    [
      'a loop node that declares no completion channel',
      '  - id: bad-loop\n    loop:\n      prompt: "Do stuff"\n      max_iterations: 5\n',
      ['completion channel', 'loop.until_bash'],
    ],
    [
      'a loop node with invalid max_iterations',
      '  - id: bad-loop\n    loop:\n      prompt: "Do stuff"\n      until: DONE\n      max_iterations: 0\n',
      ['max_iterations'],
    ],
    [
      'a node with both loop and command',
      '  - id: bad\n    command: my-cmd\n    loop:\n      prompt: "Do stuff"\n      until: DONE\n      max_iterations: 5\n',
      ['mutually exclusive'],
    ],
    [
      'a node with both loop and bash',
      '  - id: bad\n    bash: "echo hi"\n    loop:\n      prompt: "Do stuff"\n      until: DONE\n      max_iterations: 5\n',
      ['mutually exclusive'],
    ],
    [
      'an interactive loop without gate_message',
      '  - id: my-loop\n    loop:\n      prompt: Do something.\n      until: DONE\n      max_iterations: 5\n      interactive: true\n',
      ['gate_message'],
    ],
    // The error names the "exactly one" rule and both candidate fields, so authors
    // immediately understand the conflict.
    [
      'a loop node with both loop.prompt and loop.command',
      '  - id: my-loop\n    loop:\n      prompt: "Do stuff."\n      command: my-loop-cmd\n      until: DONE\n      max_iterations: 5\n',
      ['exactly one', 'loop.prompt', 'loop.command'],
    ],
    // The error offers both alternatives, so authors discover loop.command exists.
    [
      'a loop node with neither loop.prompt nor loop.command (message mentions both options)',
      '  - id: my-loop\n    loop:\n      until: DONE\n      max_iterations: 5\n',
      ['loop.prompt', 'loop.command'],
    ],
    [
      "a loop node whose loop.command is an unsafe name ('../escape')",
      '  - id: my-loop\n    loop:\n      command: "../escape"\n      until: DONE\n      max_iterations: 5\n',
      ['invalid command name', '../escape'],
    ],
    [
      'loop_group with a cyclic body',
      `  - id: grp
    loop_group:
      until: DONE
      max_iterations: 5
      nodes:
        - id: a
          prompt: "a"
          depends_on: [b]
        - id: b
          prompt: "b"
          depends_on: [a]
`,
      ['loop_group', 'Cycle'],
    ],
    [
      'loop_group body depends_on referencing an unknown node',
      `  - id: grp
    loop_group:
      until: DONE
      max_iterations: 5
      nodes:
        - id: a
          prompt: "a"
        - id: b
          prompt: "b"
          depends_on: [missing]
`,
      ['loop_group', 'unknown node'],
    ],
    [
      'a body prompt referencing a truly unknown node',
      `  - id: setup
    bash: "echo hi"
  - id: grp
    depends_on: [setup]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: work
          prompt: "Use this context: $nowhere.output"
`,
      ["unknown node '$nowhere.output'"],
    ],
    [
      'a body node id that shadows an outer-DAG node id',
      `  - id: setup
    bash: "echo hi"
  - id: grp
    depends_on: [setup]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: setup
          prompt: "shadows the outer setup node"
`,
      ['shadows a node id in the enclosing DAG'],
    ],
    // A gate or wait pauses the loop only as the body's sole terminal sink; anywhere
    // else it is a load error (#2707 step 3, #4043).
    [
      'a mid-body gate even when a later gate is the sole terminal sink',
      `  - id: grp
    loop_group:
      until_bash: '[ "$second-gate.output.decision" = "approve" ]'
      max_iterations: 3
      nodes:
        - id: first-gate
          approval:
            message: "Start?"
        - id: work
          depends_on: [first-gate]
          prompt: "do work"
        - id: second-gate
          depends_on: [work]
          approval:
            message: "Continue?"
`,
      ["loop_group 'grp' body: approval node 'first-gate' must be the body's sole terminal sink"],
    ],
  ])('should reject %s', (_, nodes, messages) => {
    expectRejected(withNodes(nodes), messages);
  });

  it('should reject unknown loop_group until_bash refs with body-scope guidance', () => {
    const error = parseError(`
name: loop-group-unknown-completion-ref
description: Group completion references a node outside its visible scopes
nodes:
  - id: group
    loop_group:
      until_bash: "test $ghost.output = ready"
      max_iterations: 2
      nodes:
        - id: ready-flag
          bash: "echo ready"
`);
    expect(error).toContain("field 'loop_group.until_bash'");
    expect(error).toContain("unknown node '$ghost.output'");
    expect(error).toContain('loop_group body or current/enclosing DAG scope');
    expect(error).not.toContain('In a composed workflow');
  });

  describe('terminal sinks through include expansion', () => {
    const root = useTempWorkflowRoot();
    const block = `
name: block
description: Reusable step
nodes:
  - id: step
    prompt: do the reusable thing
`;

    it("counts an include: directive's own depends_on when computing terminal-sink status (review fix)", async () => {
      // 'check' has a dependent — the included 'review' node — so it is NOT the
      // body's terminal sink. Before the fix, an include directive's own
      // depends_on was excluded from the dependency set, so 'check' was silently
      // misclassified as terminal.
      const result = await discoverFiles(root(), {
        'block.yaml': block,
        'loop-group-gate-include-dependent.yaml': `
name: loop-group-gate-include-dependent
description: A downstream include node depends on the gate
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: check
          approval:
            message: "Continue?"
        - id: review
          include: block
          depends_on: [check]
`,
      });
      const err = result.errors.find(e => e.filename === 'loop-group-gate-include-dependent.yaml');
      expect(err?.error).toContain("approval node 'check' must be the body's sole terminal sink");
    });

    it('counts an include: directive as a co-terminal sink (review fix)', async () => {
      // 'independent-include' has no dependents and nothing depends on it — a
      // second, genuine terminal sink alongside the gate. Before the fix, include
      // directives were excluded from the sink set entirely, so this second sink
      // was invisible and 'check' was wrongly treated as the sole terminal node.
      const result = await discoverFiles(root(), {
        'block.yaml': block,
        'loop-group-gate-include-co-terminal.yaml': `
name: loop-group-gate-include-co-terminal
description: An independent include node is a second terminal sink
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: check
          approval:
            message: "Continue?"
        - id: independent-include
          include: block
`,
      });
      const err = result.errors.find(
        e => e.filename === 'loop-group-gate-include-co-terminal.yaml'
      );
      expect(err?.error).toContain("approval node 'check' must be the body's sole terminal sink");
    });
  });
});

describe('workflow (sub-run) nodes', () => {
  /** The node with `id` in a workflow that must load. */
  const loadedNode = (yaml: string, id: string): DagNode | undefined =>
    parsedNodes(yaml).find(n => n.id === id);

  it('loads a workflow with a valid workflow: node (input + depends_on)', () => {
    const sub = loadedNode(
      `
name: compose
description: Composes a sub-run
nodes:
  - id: plan
    prompt: "plan"
  - id: sub
    workflow: child-wf
    input: "$plan.output"
    depends_on: [plan]
  - id: after
    prompt: "after"
    depends_on: [sub]
`,
      'sub'
    );
    // A workflow: node is NOT expanded at load time (unlike include:).
    expect(sub && 'workflow' in sub ? sub.workflow : undefined).toBe('child-wf');
    expect(sub && 'input' in sub ? sub.input : undefined).toBe('$plan.output');
  });

  it.each([
    ['systemPrompt', '    systemPrompt: "context $ghost.output"'],
    [
      'agents.*.prompt',
      '    agents:\n      helper:\n        description: d\n        prompt: "use $ghost.output"',
    ],
    [
      'agents.*.description',
      '    agents:\n      helper:\n        description: "reads $ghost.output"\n        prompt: p',
    ],
  ])('catches a dangling $node.output ref in %s', (_, snippet) => {
    // These three are runtime substitution surfaces since #1764, so a dangling ref has
    // to fail at load like every other one — before it reaches the provider as text.
    expect(parseError(withNodes(`  - id: use\n    prompt: go\n${snippet}\n`))).toContain(
      "references unknown node '$ghost.output'"
    );
  });

  it("accepts 'with:' on a workflow node (#2470)", () => {
    const node = loadedNode(
      withNodes('  - id: sub\n    workflow: child-wf\n    with:\n      foo: bar\n'),
      'sub'
    );
    expect(nodeWith(node)).toEqual({ foo: 'bar' });
  });

  // Per-child worktree isolation (slice 2, PR-A) and explicit inheritance both load.
  it.each(['worktree', 'inherit'])("accepts isolation: '%s' on a workflow node", isolation => {
    parseWorkflowYaml(
      withNodes(`  - id: sub\n    workflow: child-wf\n    isolation: ${isolation}\n`)
    );
  });

  it.each<[string, string, (string | RegExp)[]]>([
    [
      'a workflow.input $output ref to an unknown node',
      '  - id: sub\n    workflow: child-wf\n    input: "$ghost.output"\n',
      ["references unknown node '$ghost.output'"],
    ],
    [
      "'with:' and 'input:' together on a workflow node (#2470)",
      '  - id: sub\n    workflow: child-wf\n    input: hello\n    with:\n      foo: bar\n',
      ["'with:' and 'input:'"],
    ],
    [
      "'retry:' on a workflow node",
      '  - id: sub\n    workflow: child-wf\n    retry:\n      max_attempts: 2\n',
      ["'retry' is not supported on workflow nodes"],
    ],
    [
      "'isolation:' on a non-workflow node (S1)",
      '  - id: think\n    prompt: "do a thing"\n    isolation: worktree\n',
      ['only supported on workflow'],
    ],
    [
      'a workflow node inside a loop_group body',
      '  - id: grp\n    loop_group:\n      until: DONE\n      max_iterations: 3\n      nodes:\n        - id: bad\n          workflow: child-wf\n',
      ['loop_group', "'workflow' (sub-run) is not supported"],
    ],
    [
      'a node that sets both workflow and prompt (mutual exclusion)',
      '  - id: sub\n    workflow: child-wf\n    prompt: "also a prompt"\n',
      [/mutually exclusive/i],
    ],
    [
      'a fan_out.items ref to an unknown node (dangling ref)',
      '  - id: work\n    workflow: child-wf\n    fan_out:\n      items: "$ghost.output.tasks"\n',
      ["references unknown node '$ghost.output'"],
    ],
    // A real producer that is not an upstream dependency would race the fan-out.
    [
      'fan_out.items referencing a non-dependency producer',
      '  - id: plan\n    prompt: "emit tasks"\n  - id: work\n    workflow: child-wf\n    fan_out:\n      items: "$plan.output.tasks"\n',
      ['not an upstream dependency', 'depends_on'],
    ],
    [
      'a compose_fan_out items ref to an unknown node',
      '  - id: work\n    include: cfo-block\n    fan_out:\n      items: "$ghost.output"\n      as: item\n',
      ["references unknown node '$ghost.output'"],
    ],
    [
      'compose_fan_out items referencing a non-dependency producer',
      '  - id: list\n    bash: "echo []"\n  - id: work\n    include: cfo-block\n    fan_out:\n      items: "$list.output"\n      as: item\n',
      ['not an upstream dependency'],
    ],
    [
      'a dangling $node.output ref in a compose_fan_out with value',
      '  - id: work\n    include: cfo-block\n    with:\n      seed: "$ghost.output"\n    fan_out:\n      items: "[1, 2]"\n      as: item\n',
      ["references unknown node '$ghost.output'"],
    ],
    [
      'compose_fan_out with binding to a non-upstream producer',
      '  - id: seed\n    bash: "echo hi"\n  - id: work\n    include: cfo-block\n    with:\n      seed: "$seed.output"\n    fan_out:\n      items: "[1]"\n      as: item\n',
      ["binding 'with.seed'", 'not an upstream dependency'],
    ],
    [
      "'fan_out' on a non-workflow node",
      '  - id: think\n    prompt: "do a thing"\n    fan_out:\n      items: "$think.output"\n',
      ["'fan_out' is only supported on include or workflow nodes"],
    ],
    [
      "'fan_out.as' colliding with a 'with:' key (#2470)",
      '  - id: plan\n    prompt: "emit tasks"\n  - id: work\n    workflow: child-wf\n    depends_on: [plan]\n    with:\n      task: static\n    fan_out:\n      items: "$plan.output.tasks"\n      as: task\n',
      ['fan_out.as', 'collides'],
    ],
    [
      "'max_parallel: 0' (must be >= 1)",
      '  - id: plan\n    prompt: "emit tasks"\n  - id: work\n    workflow: child-wf\n    depends_on: [plan]\n    fan_out:\n      items: "$plan.output.tasks"\n      max_parallel: 0\n',
      [/max_parallel/],
    ],
    [
      'a fan_out workflow node inside a loop_group body',
      '  - id: grp\n    loop_group:\n      until: DONE\n      max_iterations: 3\n      nodes:\n        - id: bad\n          workflow: child-wf\n          fan_out:\n            items: "$grp.output"\n',
      ['loop_group', "'workflow' (sub-run) is not supported"],
    ],
  ])('rejects %s', (_, nodes, messages) => {
    expectRejected(withNodes(nodes), messages);
  });

  it('accepts a valid fan_out node and defaults max_parallel=5, join=all_done', () => {
    const work = loadedNode(
      `
name: fan-ok
description: fan out over a produced item list
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    isolation: worktree
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
`,
      'work'
    );
    const fanOut = work && 'fan_out' in work ? work.fan_out : undefined;
    expect(fanOut?.items).toBe('$plan.output.tasks');
    // Defaults applied by the schema.
    expect(fanOut?.max_parallel).toBe(5);
    // Independent children by default: a failed child must not discard its siblings'
    // output at the join. all_success is the opt-in for the genuinely dependent case.
    expect(fanOut?.join).toBe('all_done');
    // The explicit isolation the author wrote survives the transform.
    expect(work && 'isolation' in work ? work.isolation : undefined).toBe('worktree');
  });

  it.each([2, 'all'])('accepts explicit workflow fan-out parallelism %s', parallelism => {
    const node = loadedNode(
      `
name: fan-window
description: explicit child window
nodes:
  - id: list
    bash: echo '[]'
  - id: questions
    workflow: child-wf
    depends_on: [list]
    fan_out:
      items: "$list.output"
      max_parallel: ${parallelism}
`,
      'questions'
    );
    expect(node && 'fan_out' in node && node.fan_out?.max_parallel).toBe(parallelism);
  });

  it('reports a field error for an invalid fan-out with a padded include target', () => {
    const error = parseError(
      `
name: compose-invalid
description: invalid composed join
nodes:
  - id: work
    include: '  child-block  '
    fan_out:
      items: '[]'
      as: item
      join: first_success
`
    );
    expect(error).toContain("'fan_out.join'");
    expect(error).toContain('first_success');
    expect(error).not.toContain('YAML parse error');
  });

  it('rejects max_parallel: all on composed fan-out', () => {
    const error = parseError(
      `
name: compose-all
description: composed fan-out keeps numeric parallelism
nodes:
  - id: list
    bash: echo '[]'
  - id: work
    include: child-block
    depends_on: [list]
    fan_out:
      items: "$list.output"
      as: item
      max_parallel: all
`
    );
    expect(error).toContain('max_parallel');
  });

  it('does NOT infer isolation from fan_out — an omitted isolation stays omitted', () => {
    const work = loadedNode(
      `
name: fan-no-iso
description: fan out with no isolation declared
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
`,
      'work'
    );
    // A child gets a worktree ONLY when the author writes `isolation: worktree`.
    // Fanning out is not a write operation, so it never implies one.
    expect(work && 'isolation' in work ? work.isolation : undefined).toBeUndefined();
  });

  it("rejects 'fan_out.join: first_success' as REJECTED, not deferred", () => {
    const error = parseError(`
name: fan-race
description: first_success join is not supported yet
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      join: first_success
`);
    expect(error).toContain('first_success');
    // The message must not promise a future that no longer exists — racing is rejected
    // outright, so "not yet supported" / a PR to wait for would be acted on wrongly.
    expect(error).toContain('rejected, not deferred');
    expect(error).not.toContain('not yet supported');
    expect(error).not.toContain('PR-D');
    // …and it names the shape that actually serves the want.
    expect(error).toContain('collector');
  });

  it("accepts 'fan_out.as' now that the $INPUTS channel exists (#2470)", () => {
    const node = loadedNode(
      `
name: fan-as
description: as names the per-item $INPUTS channel
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      as: task
`,
      'work'
    );
    expect(node && 'fan_out' in node ? node.fan_out?.as : undefined).toBe('task');
  });
});

describe('discovery', () => {
  const root = useTempWorkflowRoot();

  // Expansion rebuilds every workflow and strips its node-affecting layer, so the
  // run-owned fields core reads from a discovered workflow must be carried through.
  it('keeps workflow-level run policy fields through expansion', async () => {
    const result = await discoverFiles(root(), {
      'policy.yaml': [
        'name: policy',
        'description: d',
        'worktree:',
        '  enabled: false',
        'container:',
        '  enabled: true',
        '  write_back: auto',
        'evidence_policy:',
        '  required: true',
        'tags: [GitLab, Review]',
        'mutates_checkout: false',
        'budget:',
        '  max_work_units: 3',
        'deprecated:',
        '  message: Switch instead.',
        'nodes:',
        '  - id: n',
        '    prompt: p',
        '',
      ].join('\n'),
    });
    expect(result.errors).toEqual([]);
    expect(result.workflows[0].workflow).toMatchObject({
      worktree: { enabled: false },
      container: { enabled: true, write_back: 'auto' },
      evidence_policy: { required: true },
      tags: ['GitLab', 'Review'],
      mutates_checkout: false,
      budget: { max_work_units: 3 },
      deprecated: { message: 'Switch instead.' },
    });
  });
});

describe('include nodes', () => {
  const root = useTempWorkflowRoot();

  /** The payload of the warn line logged when the include `includeId` dropped fields. */
  const droppedFieldsWarning = (includeId: string) =>
    (mockLogger.warn as Mock<(...args: unknown[]) => unknown>).mock.calls.find(
      c =>
        c[1] === 'include.workflow_level_fields_dropped' &&
        (c[0] as { include?: string }).include === includeId
    );

  it('should load and expand a workflow with an include node', async () => {
    const result = await discoverFiles(root(), {
      'block.yaml': `
name: block
description: Reusable building block
nodes:
  - id: first
    prompt: "first"
  - id: second
    prompt: "second"
    depends_on: [first]
`,
      'parent.yaml': `
name: parent
description: Includes the block
nodes:
  - id: setup
    bash: "echo setup"
  - id: sub
    include: block
    depends_on: [setup]
  - id: finish
    prompt: "finish"
    depends_on: [sub]
`,
    });
    expect(result.errors.filter(e => e.filename === 'parent.yaml')).toHaveLength(0);

    const parent = result.workflows.find(w => w.workflow.name === 'parent');
    expect(parent).toBeDefined();
    const ids = parent!.workflow.nodes.map(n => n.id);
    // include node is gone; block nodes are namespaced under the include id.
    expect(ids).toContain('sub__first');
    expect(ids).toContain('sub__second');
    expect(ids).not.toContain('sub');
    expect(parent!.workflow.nodes.some(n => 'include' in n)).toBe(false);

    // Entry node (block's `first`) inherits the include node's upstream dep.
    const entry = parent!.workflow.nodes.find(n => n.id === 'sub__first');
    expect(entry?.depends_on).toEqual(['setup']);
    // Downstream node's depends_on: [sub] rewired to the block's sink.
    const finish = parent!.workflow.nodes.find(n => n.id === 'finish');
    expect(finish?.depends_on).toEqual(['sub__second']);
  });

  it('should expand an include node inside a loop_group body', async () => {
    const result = await discoverFiles(root(), {
      'block.yaml': `
name: block
description: Reusable review block
returns: decide
nodes:
  - id: decide
    prompt: Decide whether the work is done
    output_format:
      type: object
      properties:
        done:
          type: boolean
      required: [done]
  - id: cleanup
    bash: echo cleanup
    depends_on: [decide]
`,
      'include-in-loop-group.yaml': `
name: include-in-loop-group
description: Include nested in a loop_group body
nodes:
  - id: grp
    loop_group:
      until_bash: test "$review.output.done" = true
      max_iterations: 3
      nodes:
        - id: setup
          bash: echo setup
        - id: review
          include: block
          depends_on: [setup]
        - id: summarize
          prompt: result=$review.output.done
          depends_on: [review]
`,
    });
    expect(result.errors.filter(e => e.filename === 'include-in-loop-group.yaml')).toHaveLength(0);
    const workflow = result.workflows.find(
      entry => entry.workflow.name === 'include-in-loop-group'
    )?.workflow;
    expect(workflow).toBeDefined();
    const group = (workflow?.nodes as DagNode[] | undefined)?.find(node => node.id === 'grp');
    expect(group && isLoopGroupNode(group)).toBe(true);
    if (!group || !isLoopGroupNode(group)) throw new Error('expected loop_group');
    expect(group.loop_group.nodes.map(node => node.id)).toEqual([
      'setup',
      'review__decide',
      'review__cleanup',
      'summarize',
    ]);
    expect(group.loop_group.nodes.some(node => 'include' in node)).toBe(false);
    expect(group.loop_group.until_bash).toBe('test "$review__decide.output.done" = true');
    expect(group.loop_group.nodes.find(node => node.id === 'summarize')).toMatchObject({
      source: { kind: 'inline', prompt: 'result=$review__decide.output.done' },
      depends_on: ['review__cleanup'],
    });
  });

  it('should error two files that declare the same workflow name', async () => {
    const result = await discoverFiles(root(), {
      'first.yaml': withNodes('  - id: a\n    prompt: "a"\n', 'dup-name'),
      'second.yaml': withNodes('  - id: b\n    prompt: "b"\n', 'dup-name'),
    });
    // Overrides are by filename, not name — same-name files are ambiguous, so both are
    // dropped and errored rather than silently last-wins (which would make include
    // resolution order-dependent).
    expect(result.workflows.some(w => w.workflow.name === 'dup-name')).toBe(false);
    const dupErrors = result.errors.filter(e =>
      e.error.includes("Duplicate workflow name 'dup-name'")
    );
    expect(dupErrors.length).toBe(2);
    expect(dupErrors.map(e => e.filename).sort()).toEqual(['first.yaml', 'second.yaml']);
  });

  it('should drop a workflow whose include target is missing but keep others', async () => {
    const result = await discoverFiles(root(), {
      'broken-include.yaml': withNodes(
        '  - id: sub\n    include: does-not-exist\n',
        'broken-include'
      ),
      'healthy.yaml': withNodes('  - id: only\n    prompt: "hi"\n', 'healthy'),
    });
    // Broken workflow is dropped with an error; the healthy one still loads.
    expect(result.workflows.some(w => w.workflow.name === 'broken-include')).toBe(false);
    expect(result.workflows.some(w => w.workflow.name === 'healthy')).toBe(true);
    // Expansion errors are re-keyed to the includer's real filename (not the workflow name).
    const err = result.errors.find(e => e.filename === 'broken-include.yaml');
    expect(err).toBeDefined();
    expect(err?.error).toContain('not found');
  });

  it('rejects a loop that reaches a budgeted workflow through include: (#2814)', async () => {
    const result = await discoverFiles(root(), {
      'looping-block.yaml':
        'name: looping-block\ndescription: block\nnodes:\n  - id: spin\n    loop:\n      until: done\n      max_iterations: 2\n      prompt: p\n',
      'budgeted-parent.yaml':
        'name: budgeted\ndescription: d\nbudget:\n  max_spend_usd: 2.5\nnodes:\n  - id: blk\n    include: looping-block\n',
    });
    const err = result.errors.find(e => e.filename === 'budgeted-parent.yaml');
    expect(err?.error).toContain("node 'blk__spin' is a loop node");
    expect(result.workflows.some(w => w.workflow.name === 'looping-block')).toBe(true);
  });

  it.each([
    [
      'a suspension-capable path inside a composed fan-out block',
      'gated-block',
      'nodes:\n  - id: approve\n    approval:\n      message: Approve?\n',
      `  - id: items
    bash: "echo []"
  - id: wait-for-time
    wait:
      duration_ms: 60000
  - id: fan-block
    include: gated-block
    depends_on: [items]
    fan_out:
      items: "$items.output"
      as: item
`,
    ],
    [
      'composed fan-out blocks that hide a wait',
      'waiting-block',
      'nodes:\n  - id: delay\n    wait:\n      duration_ms: 60000\n',
      `  - id: items-a
    bash: "echo []"
  - id: items-b
    bash: "echo []"
  - id: fan-block-a
    include: waiting-block
    depends_on: [items-a]
    fan_out:
      items: "$items-a.output"
      as: item
  - id: fan-block-b
    include: waiting-block
    depends_on: [items-b]
    fan_out:
      items: "$items-b.output"
      as: item
`,
    ],
  ])('rejects %s', async (_, blockName, blockNodes, parentNodes) => {
    // A wait and a suspending composed block must not race for the run cursor.
    const result = await discoverFiles(root(), {
      [`${blockName}.yaml`]: `name: ${blockName}\ndescription: block\n${blockNodes}`,
      'cfo-suspension.yaml': withNodes(parentNodes, 'cfo-suspension'),
    });
    const err = result.errors.find(e => e.filename === 'cfo-suspension.yaml');
    expect(err).toBeDefined();
    expect(err?.error).toContain('contains unsupported suspension-capable path');
  });

  it('allows a deterministic composed fan-out beside an unrelated wait', async () => {
    const result = await discoverFiles(root(), {
      'deterministic-block.yaml': `name: deterministic-block\ndescription: block\nmutates_checkout: false\ninputs:\n  item: { required: true }\nnodes:\n  - id: work\n    bash: "echo $INPUTS.item"\n`,
      'cfo-with-unrelated-wait.yaml': `name: cfo-with-unrelated-wait\ndescription: Deterministic fan-out does not own a pause cursor\nnodes:\n  - id: items\n    bash: 'echo ["a"]'\n  - id: wait-for-time\n    depends_on: [items]\n    wait:\n      duration_ms: 60000\n  - id: fan-block\n    include: deterministic-block\n    depends_on: [items]\n    fan_out:\n      items: "$items.output"\n      as: item\n`,
    });
    expect(
      result.errors.find(error => error.filename === 'cfo-with-unrelated-wait.yaml')
    ).toBeUndefined();
    expect(
      result.workflows.some(workflow => workflow.workflow.name === 'cfo-with-unrelated-wait')
    ).toBe(true);
  });

  it('warns only about the RUN-owned fields a composed workflow cannot carry', async () => {
    const result = await discoverFiles(root(), {
      'gated-block.yaml': `
name: gated-block
description: A block whose node config travels but whose run config cannot
provider: claude
requires: [github]
worktree:
  enabled: true
nodes:
  - id: work
    prompt: "do the work"
`,
      'parent.yaml': withNodes('  - id: sub\n    include: gated-block\n', 'parent'),
    });
    expect(result.errors.filter(e => e.filename === 'parent.yaml')).toHaveLength(0);

    // mockLogger is shared/accumulating across tests, so find this test's include id.
    const call = droppedFieldsWarning('sub');
    expect(call).toBeDefined();
    const payload = call![0] as {
      include: string;
      droppedFields: string[];
      requiresNote?: string;
      safetyNote?: string;
    };
    expect(payload.include).toBe('sub');
    // Run-owned: whoever starts the run decides these, so the composed file's
    // values cannot apply and the author gets told.
    expect(payload.droppedFields).toContain('worktree');
    // Node-affecting: `provider` travelled onto the block's own nodes (#1764), so
    // reporting it as dropped would now be a lie.
    expect(payload.droppedFields).not.toContain('provider');
    // `requires:` is unioned into the composing workflow's gate, not dropped.
    expect(payload.droppedFields).not.toContain('requires');
    expect(payload.requiresNote).toBeUndefined();
    // The always-present-but-undefined keys parseWorkflow emits are filtered out, so a
    // generic key derivation must NOT report them as dropped.
    expect(payload.droppedFields).not.toContain('model');
    expect(payload.safetyNote).toBeUndefined();
  });

  it("unions a composed block's requires: into the composing workflow", async () => {
    const result = await discoverFiles(root(), {
      'gh-block.yaml': `name: gh-block\ndescription: needs github\nrequires: [github]\nnodes:\n  - id: work\n    prompt: work\n`,
      'gh-parent.yaml': withNodes('  - id: sub\n    include: gh-block\n', 'gh-parent'),
    });
    const parent = result.workflows.find(w => w.workflow.name === 'gh-parent');
    // The capability gate reads this, so a user without GitHub connected is refused at
    // invocation instead of failing mid-run inside a block the parent cannot inspect.
    expect(parent?.workflow.requires).toEqual(['github']);
  });

  it('should warn — with a safety callout — when a block drops mutates_checkout', async () => {
    const result = await discoverFiles(root(), {
      'safety-block.yaml': `
name: safety-block
description: A block declaring concurrency-safety and a field that cannot travel
mutates_checkout: false
webSearchMode: live
sandbox:
  enabled: true
nodes:
  - id: work
    prompt: "do the work"
`,
      'safety-parent.yaml': withNodes(
        '  - id: safety-sub\n    include: safety-block\n',
        'safety-parent'
      ),
    });
    expect(result.errors.filter(e => e.filename === 'safety-parent.yaml')).toHaveLength(0);

    const call = droppedFieldsWarning('safety-sub');
    expect(call).toBeDefined();
    const payload = call![0] as {
      droppedFields: string[];
      safetyNote?: string;
      webSearchModeNote?: string;
    };
    expect(payload.droppedFields).toContain('mutates_checkout');
    expect(payload.safetyNote).toContain('mutates_checkout');
    // `sandbox:` is node-affecting and now travels onto the block's own nodes.
    expect(payload.droppedFields).not.toContain('sandbox');
    const work = result.workflows
      .find(w => w.workflow.name === 'safety-parent')
      ?.workflow.nodes.find(n => n.id === 'safety-sub__work') as
      | Record<string, unknown>
      | undefined;
    expect(work?.sandbox).toEqual({ enabled: true });
    // `webSearchMode:` is the one node-affecting field with no per-node landing spot,
    // so it genuinely cannot travel — named explicitly rather than left to read as a
    // run-level decision it is not.
    expect(payload.droppedFields).toContain('webSearchMode');
    expect(payload.webSearchModeNote).toContain('no per-node form');
  });

  it('warns that a composed fan-out drops the block mutates_checkout, like any include', async () => {
    const result = await discoverFiles(root(), {
      'read-only-block.yaml': `name: read-only-block\ndescription: Safe to run concurrently\nmutates_checkout: false\ninputs:\n  item: { required: true }\nnodes:\n  - id: work\n    bash: "echo $INPUTS.item"\n`,
      'fan-parent.yaml': `name: fan-parent\ndescription: Fans out the block\nnodes:\n  - id: list\n    bash: 'echo ["a"]'\n  - id: fan\n    include: read-only-block\n    depends_on: [list]\n    fan_out:\n      items: "$list.output"\n      as: item\n      max_parallel: 2\n`,
    });
    expect(result.errors.filter(e => e.filename === 'fan-parent.yaml')).toHaveLength(0);
    expect(
      (droppedFieldsWarning('fan')?.[0] as { droppedFields?: string[] } | undefined)?.droppedFields
    ).toContain('mutates_checkout');
  });

  it('does not warn that an included block dropped its deprecated: notice', async () => {
    const result = await discoverFiles(root(), {
      'deprecated-block.yaml': `name: deprecated-block\ndescription: Superseded block\ndeprecated:\n  message: Use the new block.\nnodes:\n  - id: work\n    bash: "echo work"\n`,
      'deprecated-parent.yaml': withNodes(
        '  - id: old-sub\n    include: deprecated-block\n',
        'deprecated-parent'
      ),
    });
    expect(result.errors.filter(e => e.filename === 'deprecated-parent.yaml')).toHaveLength(0);
    expect(droppedFieldsWarning('old-sub')).toBeUndefined();
  });

  it('should compile a block command file and namespace a local sibling ref', async () => {
    const commandsDir = join(root(), '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'blk-runner.md'), 'Summarize $sib.output for the report.');

    const result = await discoverFiles(root(), {
      'cmd-block.yaml': `
name: cmd-block
description: Block whose command references a sibling
nodes:
  - id: sib
    bash: "echo hi"
  - id: runner
    command: blk-runner
    depends_on: [sib]
`,
      'cmd-parent.yaml': withNodes('  - id: rev\n    include: cmd-block\n', 'cmd-parent'),
    });
    expect(result.errors.filter(error => error.filename === 'cmd-parent.yaml')).toHaveLength(0);
    const parent = result.workflows.find(w => w.workflow.name === 'cmd-parent')?.workflow;
    const runner = parent?.nodes.find(node => node.id === 'rev__runner');
    expect(inlinePrompt(runner) ?? '').toBe('Summarize $rev__sib.output for the report.');
  });

  it('should compile a resolved block command file with a declared include input', async () => {
    const commandsDir = join(root(), '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'parameterized-runner.md'), 'Review $INPUTS.scope.');

    const result = await discoverFiles(root(), {
      'parameterized-block.yaml': `
name: parameterized-block
description: Block whose command references an include input
inputs:
  scope: { required: true }
nodes:
  - id: runner
    command: parameterized-runner
`,
      'parameterized-parent.yaml': withNodes(
        '  - id: review\n    include: parameterized-block\n    with:\n      scope: main\n',
        'parameterized-parent'
      ),
    });
    expect(
      result.errors.filter(error => error.filename === 'parameterized-parent.yaml')
    ).toHaveLength(0);
    const parent = result.workflows.find(
      workflow => workflow.workflow.name === 'parameterized-parent'
    )?.workflow;
    const runner = parent?.nodes.find(node => node.id === 'review__runner');
    expect(inlinePrompt(runner) ?? '').toBe('Review main.');
  });

  it('should compile block commands from a configured custom command folder', async () => {
    const customCmds = join(root(), 'my-cmds');
    await mkdir(customCmds, { recursive: true });
    await writeFile(join(customCmds, 'custom-runner.md'), 'Summarize $sib.output for the report.');
    await writeWorkflowFile(
      root(),
      'cc-block.yaml',
      `
name: cc-block
description: block whose command lives in a custom folder
nodes:
  - id: sib
    bash: "echo hi"
  - id: runner
    command: custom-runner
    depends_on: [sib]
`
    );
    await writeWorkflowFile(
      root(),
      'cc-parent.yaml',
      withNodes('  - id: rev\n    include: cc-block\n', 'cc-parent')
    );

    const result = await discoverWorkflowsWithConfig(
      root(),
      () =>
        Promise.resolve({
          defaults: { loadDefaultWorkflows: false },
          commands: { folder: 'my-cmds' },
        }),
      providerRegistry
    );
    expect(result.errors.filter(error => error.filename === 'cc-parent.yaml')).toHaveLength(0);
    const parent = result.workflows.find(
      workflow => workflow.workflow.name === 'cc-parent'
    )?.workflow;
    const runner = parent?.nodes.find(node => node.id === 'rev__runner');
    expect(inlinePrompt(runner) ?? '').toBe('Summarize $rev__sib.output for the report.');
  });

  it('should fail closed when a block command file cannot be resolved', async () => {
    const result = await discoverFiles(root(), {
      'ghost-block.yaml': `
name: ghost-block
description: Block whose command file does not exist on disk
nodes:
  - id: runner
    command: ghost-cmd-does-not-exist-xyz
`,
      'ghost-parent.yaml': withNodes('  - id: g\n    include: ghost-block\n', 'ghost-parent'),
    });
    const parentErrors = result.errors.filter(e => e.filename === 'ghost-parent.yaml');
    expect(parentErrors).toHaveLength(1);
    expect(result.workflows.some(w => w.workflow.name === 'ghost-parent')).toBe(false);
    expect(parentErrors[0].error).toContain("command 'ghost-cmd-does-not-exist-xyz'");
    expect(parentErrors[0].error).toContain('could not be resolved during composition');
  });

  it('should compile an included loop.command file with declared inputs', async () => {
    const commandDir = join(root(), '.archon', 'commands');
    await mkdir(commandDir, { recursive: true });
    await writeFile(join(commandDir, 'loop-review.md'), 'Review $INPUTS.scope.');

    const result = await discoverFiles(root(), {
      'loop-block.yaml': `
name: loop-block
description: Block with a deferred loop prompt
inputs:
  scope: { required: true }
nodes:
  - id: repeat
    loop:
      command: loop-review
      until: DONE
      max_iterations: 1
`,
      'loop-parent.yaml': withNodes(
        '  - id: review\n    include: loop-block\n    with:\n      scope: production\n',
        'loop-parent'
      ),
    });
    expect(result.errors.filter(error => error.filename === 'loop-parent.yaml')).toHaveLength(0);
    const parent = result.workflows.find(
      workflow => workflow.workflow.name === 'loop-parent'
    )?.workflow;
    const repeat = parent?.nodes.find(node => node.id === 'review__repeat');
    const compiled =
      repeat && 'loop' in repeat
        ? (repeat.loop as typeof repeat.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]
        : undefined;
    expect(compiled?.prompt).toBe('Review production.');
    expect(repeat && 'loop' in repeat && repeat.loop ? repeat.loop.command : undefined).toBe(
      'loop-review'
    );
  });
});

describe('cancel nodes', () => {
  it('should parse a valid cancel node', () => {
    const nodes = parsedNodes(`
name: cancel-test
description: Cancel node test
nodes:
  - id: check
    bash: "echo ok"
  - id: stop
    depends_on: [check]
    cancel: "Precondition failed"
`);
    expect(nodes).toHaveLength(2);
    const node1 = nodes[1];
    expect(isHaltNode(node1)).toBe(true);
    if (isHaltNode(node1)) {
      expect(node1.reason).toBe('Precondition failed');
    }
  });

  it('should reject cancel node with empty reason', () => {
    expect(
      parseWorkflow(withNodes('  - id: stop\n    cancel: ""\n'), 'cancel-empty.yaml').error
    ).not.toBeNull();
  });

  it('should reject node with both cancel and prompt', () => {
    expect(
      parseError(withNodes('  - id: bad\n    cancel: "reason"\n    prompt: "Do something"\n'))
    ).toContain('mutually exclusive');
  });

  it('should warn about AI-specific fields on cancel nodes', () => {
    const { warnings } = parseWorkflowYaml(
      withNodes('  - id: stop\n    cancel: "reason"\n    model: opus\n    provider: claude\n')
    );
    expect(warnings[0]).toContain("'provider', 'model' are not supported");
  });
});

// ---------------------------------------------------------------------------
// #2637 — node-local `with:` bindings on command/script nodes, and JSON-valued
// `with:` maps. Load-time validation: shape, whole-ref grammar, upstream
// dependency, env-key uniqueness, and the ignored-elsewhere warning.
// ---------------------------------------------------------------------------

describe('node-local with: bindings (#2637)', () => {
  it('accepts and round-trips typed values and a binding directive on command and script nodes', () => {
    const { workflow } = parseWorkflowYaml(`
name: bind-ok
description: node-local bindings load and survive the transform
nodes:
  - id: producer
    prompt: emit
    output_format:
      type: object
      properties:
        green: { type: boolean }
  - id: consume
    command: review
    depends_on: [producer]
    with:
      green: $producer.output.green
      typed: 42
      guarded:
        from: $producer.output.green
        if_skipped: false
  - id: emit
    script: console.log("x")
    runtime: bun
    depends_on: [producer]
    with:
      payload: $producer.output
`);
    const consume = workflow.nodes.find(n => n.id === 'consume');
    expect(nodeWith(consume)).toEqual({
      green: '$producer.output.green',
      typed: 42,
      guarded: { from: '$producer.output.green', if_skipped: false },
    });
    const emit = workflow.nodes.find(n => n.id === 'emit');
    expect(nodeWith(emit)).toEqual({
      payload: '$producer.output',
    });
  });

  it('accepts typed JSON values on a workflow node with: map (previously a load error)', () => {
    const { workflow } = parseWorkflowYaml(`
name: typed-with
description: pure relaxation — with values are JSON now
nodes:
  - id: sub
    workflow: some-child
    with:
      flag: true
      count: 3
      tags: [a, b]
`);
    const sub = workflow.nodes.find(n => n.id === 'sub');
    expect(nodeWith(sub)).toEqual({
      flag: true,
      count: 3,
      tags: ['a', 'b'],
    });
  });

  it('rejects a binding ref to an unknown producer at load time', () => {
    const result = parseWorkflow(
      `
name: bind-unknown
description: binding names a node that does not exist
nodes:
  - id: consume
    command: review
    with:
      v: $ghost.output
`,
      'bind-unknown.yaml'
    );
    expect(result.error?.error).toContain("references unknown node '$ghost.output'");
  });

  it('rejects a binding whose producer is not an upstream dependency, naming the fix', () => {
    const result = parseWorkflow(
      `
name: bind-not-upstream
description: producer exists but there is no depends_on edge
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    with:
      v: $producer.output
`,
      'bind-not-upstream.yaml'
    );
    expect(result.error?.error).toContain(
      "add 'producer' to 'consume'.depends_on so its value is produced first"
    );
  });

  it('rejects a directive whose from is not a whole ref, and enforces upstream for directive refs too', () => {
    const badFrom = parseWorkflow(
      `
name: bind-bad-from
description: from must be exactly one whole ref
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    depends_on: [producer]
    with:
      v:
        from: "prefix $producer.output"
`,
      'bind-bad-from.yaml'
    );
    expect(badFrom.error?.error).toContain(
      "'from' must be exactly one whole '$node.output[.a.b]' reference"
    );

    const notUpstream = parseWorkflow(
      `
name: bind-directive-race
description: directive producer without a depends_on edge
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    with:
      v:
        from: $producer.output.green
`,
      'bind-directive-race.yaml'
    );
    expect(notUpstream.error?.error).toContain("add 'producer' to 'consume'.depends_on");
  });

  it('does not validate output references in an if_skipped literal default', () => {
    const result = parseWorkflow(
      `
name: bind-default-literal
description: defaults are delivered literally when a producer is skipped
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    depends_on: [producer]
    with:
      value:
        from: $producer.output
        if_skipped: $not-a-producer.output
`,
      'bind-default-literal.yaml'
    );
    expect(result.error).toBeNull();
  });

  it('rejects an object binding value that is not the directive shape, naming both accepted forms', () => {
    const result = parseWorkflow(
      `
name: bind-bad-object
description: plain object literals are reserved for the directive
nodes:
  - id: consume
    command: review
    with:
      v:
        some: thing
`,
      'bind-bad-object.yaml'
    );
    expect(result.error?.error).toContain('must be a binding directive');
    expect(result.error?.error).toContain('literal value');
  });

  it("rejects $LOOP_PREV in a directive's from, naming the string form that works", () => {
    // $LOOP_PREV is per-iteration text substitution, not a node ref — the directive
    // needs a producer to check for `if_skipped`. The generic grammar error would be
    // technically true and useless; the message must point at the supported spelling.
    const result = parseWorkflow(
      `
name: bind-loopprev-directive
description: directive from cannot read the previous iteration
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: gen
          prompt: Draft.
        - id: consume
          script: console.log("x")
          runtime: bun
          depends_on: [gen]
          with:
            prev:
              from: $LOOP_PREV.gen.output
              if_skipped: ''
`,
      'bind-loopprev-directive.yaml'
    );
    expect(result.error?.error).toContain("'from' cannot read '$LOOP_PREV'");
    expect(result.error?.error).toContain('prev: $LOOP_PREV.gen.output');
  });

  it('rejects two binding names that fold to one INPUTS_<UPPER_SNAKE> env key', () => {
    const result = parseWorkflow(
      `
name: bind-env-collision
description: foo-bar and foo_bar collide on INPUTS_FOO_BAR
nodes:
  - id: emit
    script: console.log("x")
    runtime: bun
    with:
      foo-bar: a
      foo_bar: b
`,
      'bind-env-collision.yaml'
    );
    expect(result.error?.error).toContain("both map to env var 'INPUTS_FOO_BAR'");
  });

  it('rejects with: on a node type that cannot deliver it', () => {
    const result = parseWorkflow(
      `
name: with-ignored
description: with on bash never reaches the script
nodes:
  - id: run
    bash: echo hi
    with: [ignored]
`,
      'with-ignored.yaml'
    );
    expect(result.error?.error).toContain(
      "'with' is only supported on command, script, include or workflow nodes, not on bash nodes."
    );
  });
});

it('parsing uses only the supplied registry for provider identity', () => {
  const claude = providerRegistry.get('claude');
  if (!claude) throw new Error('test registry must contain Claude');
  const custom = { ...claude, id: 'custom' };
  const providers = {
    get: (id: string) => (id === custom.id ? custom : undefined),
    list: () => [custom],
  };
  const yaml = `name: registry-port
description: Registry boundary
provider: custom
nodes:
  - id: act
    prompt: Do something
`;
  expect(parseWorkflowWithProviders(yaml, 'registry.yaml', providers).error).toBeNull();
  const result = parseWorkflowWithProviders(
    yaml.replace('provider: custom', 'provider: claude'),
    'registry.yaml',
    providers
  );
  expect(result.error?.error).toBe(
    "Provider 'claude' is not installed. Add it with: archon provider add claude"
  );
});

describe('attention wait labels', () => {
  const parseLabels = (labels: string, dependsOn = '[plan]') =>
    parseWorkflow(
      `name: labeled
description: Labels on an attention wait
nodes:
  - id: plan
    bash: echo '{}'
  - id: other
    bash: echo '{}'
  - id: ask
    depends_on: ${dependsOn}
    wait:
      attention: CI is red. Retry?
      labels: ${labels}
`,
      'labeled.yaml'
    );

  it('loads literal labels and labels that reference an upstream output', () => {
    expect(parseLabels('{ ci: "$plan.output.cause", area: delivery }').error).toBeNull();
  });

  it('rejects a label key a CLI filter could not name', () => {
    expect(parseLabels('{ "ci=x": other }').error).not.toBeNull();
  });

  it('rejects a label that references a node the wait does not depend on', () => {
    expect(parseLabels('{ ci: "$other.output.cause" }').error?.error).toContain(
      "field 'wait.labels.ci' references '$other.output', which is not an upstream dependency"
    );
  });
});
