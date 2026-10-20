// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import {
  isExecNode,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  GATE_AND_HALT_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  WAIT_NODE_IGNORED_FIELDS,
  BASH_NODE_AI_FIELDS,
  dagNodeFlatSchema,
  dagNodeSchema,
  execNodeSchema,
} from './schemas';
import { NODE_MODE_KEYS, type NodeMode } from './schemas/dag-node';
import type { DagNode, ExecNode } from './schemas';
import { validationError } from './schema-test-utils';

describe('dagNodeSchema — ExecNode', () => {
  test('derives authored exec fields from the resolved ExecNode owner', () => {
    expect(dagNodeFlatSchema.shape.deps.unwrap()).toBe(execNodeSchema.shape.deps);
    expect(KNOWN_DAG_NODE_KEYS).toEqual(new Set(Object.keys(dagNodeFlatSchema.shape)));

    const authoredRuntime = dagNodeFlatSchema.shape.runtime.unwrap();
    expect(authoredRuntime.options).toEqual(
      execNodeSchema.shape.runtime.options.filter(runtime => runtime !== 'sh')
    );

    const raw = { id: 's', script: '   ', runtime: 'bun' };
    const flat = dagNodeFlatSchema.safeParse(raw);
    const authored = dagNodeSchema.safeParse(raw);
    const resolved = execNodeSchema.safeParse({
      id: 's',
      kind: 'exec',
      script: '   ',
      runtime: 'bun',
    });
    expect(flat.success).toBe(true);
    expect(authored.success).toBe(false);
    expect(resolved.success).toBe(false);
    if (!authored.success && !resolved.success) {
      expect(authored.error.issues[0]?.message).toBe(resolved.error.issues[0]?.message);
    }
  });

  test('parses a bun script node with inline script', () => {
    const result = dagNodeSchema.parse({
      id: 'fetch',
      script: 'console.log("hello")',
      runtime: 'bun',
    });
    expect(isExecNode(result as DagNode)).toBe(true);
    const node = result as ExecNode;
    expect(node.script).toBe('console.log("hello")');
    expect(node.runtime).toBe('bun');
  });

  test('parses a uv script node with inline script', () => {
    const result = dagNodeSchema.parse({
      id: 'py',
      script: 'print("hello")',
      runtime: 'uv',
    });
    expect(isExecNode(result as DagNode)).toBe(true);
    const node = result as ExecNode;
    expect(node.runtime).toBe('uv');
  });

  test('parses a script node with deps', () => {
    const result = dagNodeSchema.parse({
      id: 's',
      script: 'import httpx',
      runtime: 'uv',
      deps: ['httpx', 'beautifulsoup4'],
    });
    const node = result as ExecNode;
    expect(node.deps).toEqual(['httpx', 'beautifulsoup4']);
  });

  test('parses a script node with timeout', () => {
    const result = dagNodeSchema.parse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      timeout: 30000,
    });
    const node = result as ExecNode;
    expect(node.timeout).toBe(30000);
  });

  test.each([
    ['bash', { id: 'shell', bash: 'sleep 30', timeout: 100, on_timeout: 'skip' }],
    [
      'script',
      {
        id: 'program',
        script: 'await Bun.sleep(30_000)',
        runtime: 'bun',
        timeout: 100,
        on_timeout: 'skip',
      },
    ],
  ] as const)('parses on_timeout: skip on a %s node', (_kind, input) => {
    const result = dagNodeSchema.parse(input);
    expect((result as ExecNode).on_timeout).toBe('skip');
  });

  test('rejects unsupported timeout outcomes', () => {
    expect(
      dagNodeSchema.safeParse({
        id: 'shell',
        bash: 'sleep 30',
        timeout: 100,
        on_timeout: 'fail',
      }).success
    ).toBe(false);
  });

  test('parses a script node with depends_on', () => {
    const result = dagNodeSchema.parse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      depends_on: ['prev'],
    });
    const node = result as ExecNode;
    expect(node.depends_on).toEqual(['prev']);
  });

  test('rejects script node without runtime', () => {
    const error = validationError(
      dagNodeSchema.safeParse({ id: 's', script: 'console.log("hi")' })
    );
    expect(error.issues[0].message).toContain('runtime');
  });

  test.each([
    [
      'rejects invalid runtime value',
      {
        id: 's',
        script: 'console.log("hi")',
        runtime: 'node',
      },
      false,
    ],
    [
      'rejects negative timeout on script node',
      {
        id: 's',
        script: 'console.log("hi")',
        runtime: 'bun',
        timeout: -1,
      },
      false,
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(dagNodeSchema.safeParse(input).success).toBe(expected);
  });

  test("keeps the internal 'sh' runtime behind the authored bash projection", () => {
    const authoredScript = dagNodeSchema.safeParse({
      id: 's',
      script: 'echo hi',
      runtime: 'sh',
    });
    expect(authoredScript.success).toBe(false);

    const authoredBash = dagNodeSchema.parse({ id: 's', bash: 'echo hi' });
    expect(authoredBash).toMatchObject({
      kind: 'exec',
      script: 'echo hi',
      runtime: 'sh',
    });
  });

  // One valid node per mode, and one valid value for every mode-owned key. Typed by
  // NodeMode so a new mode fails to compile until it has a row; a new key fails the
  // completeness check below until it has a sample.
  const MINIMAL_NODE: Record<NodeMode, Record<string, unknown>> = {
    command: { command: 'review' },
    prompt: { prompt: 'Review this.' },
    bash: { bash: 'echo hi' },
    loop: { loop: { prompt: 'Review this.', until: 'DONE', max_iterations: 1 } },
    loop_group: {
      loop_group: {
        until: 'DONE',
        max_iterations: 1,
        nodes: [{ id: 'review', prompt: 'Review this.' }],
      },
    },
    approval: { approval: { message: 'Continue?' } },
    wait: { wait: { duration_ms: 1 } },
    cancel: { cancel: 'Stop.' },
    script: { script: 'console.log("hi")', runtime: 'bun' },
    include: { include: 'child' },
    workflow: { workflow: 'child' },
  };
  const SAMPLE_VALUE: Record<string, unknown> = {
    with: { topic: 'x' },
    timeout: 1000,
    on_timeout: 'skip',
    runtime: 'bun',
    deps: ['zod'],
    fan_out: { items: '$list.output', as: 'item' },
    input: 'do the thing',
    isolation: 'worktree',
  };
  const modes = [...NODE_MODE_KEYS.keys()];
  // Another mode's selector is the mutual-exclusion error, covered elsewhere.
  const nonSelectorKeys = [
    ...new Set(modes.flatMap(m => [...(NODE_MODE_KEYS.get(m) ?? [])])),
  ].filter(key => !(modes as string[]).includes(key));

  test('every non-selector mode key has a sample value', () => {
    expect(Object.keys(SAMPLE_VALUE).sort()).toEqual([...nonSelectorKeys].sort());
  });

  const foreignKeyCases = modes.flatMap(mode =>
    nonSelectorKeys
      .filter(key => !NODE_MODE_KEYS.get(mode)?.has(key))
      .map(key => [mode, key] as const)
  );

  test.each(foreignKeyCases)(
    'rejects %s node carrying %s, naming the key, node and owning modes',
    (mode, key) => {
      const result = dagNodeSchema.safeParse({
        id: 'n1',
        ...MINIMAL_NODE[mode],
        [key]: SAMPLE_VALUE[key],
      });
      const issues = result.error?.issues ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual([key]);
      expect(issues[0]?.message).toContain(`'${key}'`);
      // The include launch-only reasons point at 'workflow:' instead of naming the node.
      if (mode === 'include' && (key === 'isolation' || key === 'input')) return;
      expect(issues[0]?.message).toContain(`not on ${mode} node 'n1'`);
      for (const owner of modes.filter(m => NODE_MODE_KEYS.get(m)?.has(key))) {
        expect(issues[0]?.message).toContain(owner);
      }
    }
  );

  test.each([
    [
      { id: 'n1', prompt: 'p', runtime: 'bun' },
      "'runtime' is only supported on script nodes, not on prompt node 'n1'",
    ],
    [
      { id: 'n1', command: 'c', input: 'x' },
      "'input' is only supported on workflow nodes, not on command node 'n1'",
    ],
    [
      { id: 'n1', bash: 'echo', deps: ['zod'] },
      "'deps' is only supported on script nodes, not on bash node 'n1'",
    ],
    [
      { id: 'n1', prompt: 'p', with: { a: 'b' } },
      "'with' is only supported on command, script, include or workflow nodes",
    ],
    [
      { id: 'n1', command: 'c', timeout: 5 },
      "'timeout' is only supported on bash, loop, loop_group or script nodes",
    ],
    // A value the owning mode would also refuse still reports the placement.
    [
      { id: 'n1', prompt: 'p', on_timeout: 123 },
      "'on_timeout' is only supported on bash or script nodes, not on prompt node 'n1'",
    ],
    [
      { id: 'n1', prompt: 'p', runtime: 'perl' },
      "'runtime' is only supported on script nodes, not on prompt node 'n1'",
    ],
  ])('names the owning modes for %o', (node, expected) => {
    const error = validationError(dagNodeSchema.safeParse(node));
    expect(error.issues[0]?.message).toContain(expected);
  });

  test('accepts every key on a mode that owns it', () => {
    for (const mode of modes) {
      for (const key of NODE_MODE_KEYS.get(mode) ?? []) {
        if (!(key in SAMPLE_VALUE)) continue;
        const result = dagNodeSchema.safeParse({
          id: 'n1',
          ...MINIMAL_NODE[mode],
          [key]: SAMPLE_VALUE[key],
        });
        expect(result.success, `${key} on ${mode}`).toBe(true);
      }
    }
  });

  test('rejects a loop setting written at the top level of a node', () => {
    const untilBashError = validationError(
      dagNodeSchema.safeParse({ id: 'n1', prompt: 'p', until_bash: 'exit 0' })
    );
    expect(untilBashError.issues[0]?.path).toEqual(['until_bash']);
    expect(untilBashError.issues[0]?.message).toBe(
      "'until_bash' is only honoured inside 'loop:' or 'loop_group:'; at the top level of node 'n1' nothing reads it."
    );

    const misplacedOnLoop = dagNodeSchema.safeParse({
      id: 'n1',
      ...MINIMAL_NODE.loop,
      max_iterations: 3,
    });
    expect(misplacedOnLoop.success).toBe(false);

    const bodyInteractiveError = validationError(
      dagNodeSchema.safeParse({
        id: 'outer',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [{ id: 'check', prompt: 'check it', interactive: true }],
        },
      })
    );
    const message = bodyInteractiveError.issues.map(i => i.message).join(' | ');
    expect(message).toContain("'interactive' is only honoured inside");
    expect(message).toContain("node 'check'");
    expect(message).toContain('wait: { attention: <message> }');
  });

  test('validates with against the exec owner after script mode is selected', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'script',
        script: 'console.log("hi")',
        runtime: 'bun',
        with: ['not-a-map'],
      })
    );
    expect(error.issues[0]?.message).toBe(
      "'with' on script nodes must be an object mapping input names to values"
    );
  });

  // The command and script paths must reject the same authored input names. They
  // reached one validator before the owner-derived split; a script path that skips
  // validateWithShape silently widens the accepted key grammar for scripts only.
  test('rejects an invalid input name on script with, exactly as command does', () => {
    const script = dagNodeSchema.safeParse({
      id: 'script',
      script: 'console.log("hi")',
      runtime: 'bun',
      with: { '1bad': 'value' },
    });
    const command = dagNodeSchema.safeParse({
      id: 'command',
      command: 'thing',
      with: { '1bad': 'value' },
    });
    expect(script.success).toBe(false);
    expect(command.success).toBe(false);
    if (!script.success && !command.success) {
      const nameIssue = (issues: readonly { message: string }[]) =>
        issues.find(i => /invalid (script|command) input name/.test(i.message))?.message;
      expect(nameIssue(script.error.issues)).toBe(
        "invalid script input name '1bad'; use letters, numbers, underscores, or hyphens and start with a letter or underscore"
      );
      expect(nameIssue(command.error.issues)).toBe(
        "invalid command input name '1bad'; use letters, numbers, underscores, or hyphens and start with a letter or underscore"
      );
    }
  });

  test('rejects empty script string', () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 's', script: '', runtime: 'bun' }));
    expect(error.issues[0].message).toBe('script cannot be empty');
  });

  test('rejects whitespace-only script', () => {
    const error = validationError(
      dagNodeSchema.safeParse({ id: 's', script: '   ', runtime: 'bun' })
    );
    expect(error.issues[0].message).toBe('script cannot be empty');
  });

  test('rejects script + bash (mutually exclusive)', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 's',
        script: 'console.log("hi")',
        bash: 'echo hi',
        runtime: 'bun',
      })
    );
    expect(error.issues[0].message).toContain('mutually exclusive');
  });

  test('rejects script + prompt (mutually exclusive)', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 's',
        script: 'console.log("hi")',
        prompt: 'Do something',
        runtime: 'bun',
      })
    );
    expect(error.issues[0].message).toContain('mutually exclusive');
  });

  test('rejects script + command (mutually exclusive)', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 's',
        script: 'console.log("hi")',
        command: 'some-command',
        runtime: 'bun',
      })
    );
    expect(error.issues[0].message).toContain('mutually exclusive');
  });

  test('strips AI-only fields from script nodes', () => {
    const result = dagNodeSchema.parse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      effort: 'high',
    });
    expect('effort' in result).toBe(false);
  });
});

describe('SCRIPT_NODE_AI_FIELDS', () => {
  test('contains provider and model fields', () => {
    expect(SCRIPT_NODE_AI_FIELDS).toContain('provider');
    expect(SCRIPT_NODE_AI_FIELDS).toContain('model');
  });

  test('contains all AI-specific fields', () => {
    const expectedFields = [
      'provider',
      'model',
      'context',
      'allowed_tools',
      'denied_tools',
      'hooks',
      'mcp',
      'skills',
      'plugins',
      'effort',
      'maxBudgetUsd',
      'systemPrompt',
      'fallbackModel',
      'betas',
      'sandbox',
    ];
    for (const field of expectedFields) {
      expect(SCRIPT_NODE_AI_FIELDS).toContain(field);
    }
  });

  test('excludes output_format, which exec nodes now enforce (#2453)', () => {
    expect(BASH_NODE_AI_FIELDS).not.toContain('output_format');
    expect(SCRIPT_NODE_AI_FIELDS).not.toContain('output_format');
    for (const list of [
      GATE_AND_HALT_IGNORED_FIELDS,
      INCLUDE_NODE_IGNORED_FIELDS,
      WAIT_NODE_IGNORED_FIELDS,
    ]) {
      for (const field of BASH_NODE_AI_FIELDS) expect(list).toContain(field);
    }
    expect(GATE_AND_HALT_IGNORED_FIELDS).toContain('output_format');
    expect(LOOP_GROUP_NODE_AI_FIELDS).toContain('output_format');
    expect(INCLUDE_NODE_IGNORED_FIELDS).toContain('output_format');
    expect(WAIT_NODE_IGNORED_FIELDS).not.toContain('output_format');
    expect(
      dagNodeSchema.safeParse({
        id: 'w',
        wait: { duration_ms: 5000 },
        output_format: { type: 'object' },
      }).success
    ).toBe(false);
  });

  test('an exec node KEEPS output_format through the transform (#2453)', () => {
    const outputFormat = { type: 'object', properties: { ready: { type: 'boolean' } } };
    for (const body of [
      { bash: 'echo hi' },
      { script: 'console.log("hi")', runtime: 'bun' },
    ] as const) {
      const node = dagNodeSchema.parse({ id: 'n', ...body, output_format: outputFormat });
      if (node.kind !== 'exec') throw new Error('Expected exec node');
      expect(node.output_format).toEqual(outputFormat);
    }
  });
});
