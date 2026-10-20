// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import {
  isLoopNode,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  WAIT_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  BASH_NODE_AI_FIELDS,
  approvalOnRejectSchema,
  dagNodeSchema,
} from './schemas';
import type { DagNode, AgentNode } from './schemas';
import { validationError } from './schema-test-utils';

describe('dagNodeSchema — context', () => {
  test('parses scalar and named resume contexts on AI consumers', () => {
    expect(
      (dagNodeSchema.parse({ id: 'fresh', prompt: 'work', context: 'fresh' }) as DagNode).context
    ).toBe('fresh');
    expect(
      (dagNodeSchema.parse({ id: 'shared', command: 'work', context: 'shared' }) as DagNode).context
    ).toBe('shared');
    expect(
      (
        dagNodeSchema.parse({
          id: 'named',
          prompt: 'work',
          context: { resume: 'source' },
        }) as DagNode
      ).context
    ).toEqual({ resume: 'source' });
  });

  test('rejects named resume on a deterministic node instead of stripping it', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'shell',
        bash: 'echo work',
        context: { resume: 'source' },
      })
    );
    expect(error.issues[0]?.message).toContain(
      "'context.resume' is only supported on command and prompt nodes"
    );
  });
});

describe('dagNodeSchema — mcp', () => {
  const parseMcp = (mcp: unknown) => dagNodeSchema.safeParse({ id: 'node', prompt: 'work', mcp });

  test('keeps the string form as a required path', () => {
    const result = parseMcp(' .archon/mcp/github.json ');
    expect(result.success && (result.data as DagNode).mcp).toBe('.archon/mcp/github.json');
  });

  test('parses the optional form and trims its path', () => {
    const result = parseMcp({ path: ' .archon/mcp/posthog.json ', optional: true });
    expect(result.success && (result.data as DagNode).mcp).toEqual({
      path: '.archon/mcp/posthog.json',
      optional: true,
    });
  });

  test('rejects a misspelled key instead of treating the server as required', () => {
    expect(parseMcp({ path: 'mcp.json', optinal: true }).success).toBe(false);
  });

  test('rejects an empty path', () => {
    const result = parseMcp({ path: '', optional: true });
    expect(result.success).toBe(false);
  });
});

describe('approvalOnRejectSchema', () => {
  test.each([
    [
      'accepts valid on_reject config',
      {
        prompt: 'Fix: $REJECTION_REASON',
        max_attempts: 3,
      },
      true,
    ],
    ['accepts on_reject without max_attempts (uses default)', { prompt: 'Please revise' }, true],
    ['rejects max_attempts: 0', { prompt: 'Fix it', max_attempts: 0 }, false],
    ['rejects max_attempts: 11', { prompt: 'Fix it', max_attempts: 11 }, false],
  ] as const)('%s', (_name, input, expected) => {
    expect(approvalOnRejectSchema.safeParse(input).success).toBe(expected);
  });

  test('rejects empty prompt', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('on_reject.prompt');
  });
});

describe('approval.decisions', () => {
  const parseGate = (approval: unknown) => {
    const node = dagNodeSchema.parse({ id: 'gate', approval });
    if (node.kind !== 'gate') throw new Error('Expected gate');
    return node;
  };
  test('parses a valid explicit decisions array, marking decisionsAuthored', () => {
    const decisions = [{ id: 'approve', label: 'Ship it' }, { id: 'reject' }];
    const node = parseGate({ message: 'ok?', decisions });
    expect(node.decisionsAuthored).toBe(true);
    expect(node.decisions).toEqual(decisions);
  });

  test('omitted decisions synthesizes the default pair with decisionsAuthored: false', () => {
    const node = parseGate({ message: 'ok?' });
    expect(node.decisionsAuthored).toBe(false);
    expect(node.decisions).toEqual([{ id: 'approve' }, { id: 'reject' }]);
  });

  test.each([
    { decisions: [{ id: 'accept' }, { id: 'revise' }] },
    { decisions: [{ id: 'reject' }] },
  ])('accepts an authored vocabulary without approve (%j)', ({ decisions }) => {
    const result = parseGate({ message: 'Choose', decisions });
    expect(result.decisionsAuthored).toBe(true);
    expect(result.decisions).toEqual([...decisions]);
  });

  test('rejects duplicate ids', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'ok?', decisions: [{ id: 'approve' }, { id: 'approve' }] },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unique');
  });

  test.each([
    [
      'accepts an approve-only decisions array (acknowledge gate, reject optional)',
      {
        id: 'gate',
        approval: { message: 'ok?', decisions: [{ id: 'approve' }] },
      },
      true,
    ],
    [
      'rejects an empty decisions array',
      {
        id: 'gate',
        approval: { message: 'ok?', decisions: [] },
      },
      false,
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(dagNodeSchema.safeParse(input).success).toBe(expected);
  });

  test('rejects decisions combined with on_reject — mutually exclusive', () => {
    const result = dagNodeSchema.safeParse({
      id: 'gate',
      approval: {
        message: 'ok?',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
        on_reject: { prompt: 'fix it' },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('mutually exclusive');
  });
});

describe('dagNodeSchema — empty bash/prompt', () => {
  test('emits "bash script cannot be empty" for bash: ""', () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 'n1', bash: '' }));
    expect(error.issues[0].message).toBe('bash script cannot be empty');
  });

  test('emits "bash script cannot be empty" for whitespace-only bash', () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 'n1', bash: '   ' }));
    expect(error.issues[0].message).toBe('bash script cannot be empty');
  });

  test('emits "prompt cannot be empty" for prompt: ""', () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 'n1', prompt: '' }));
    expect(error.issues[0].message).toBe('prompt cannot be empty');
  });

  test('emits "prompt cannot be empty" for whitespace-only prompt', () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 'n1', prompt: '   ' }));
    expect(error.issues[0].message).toBe('prompt cannot be empty');
  });

  test('passes for bash: "echo hello"', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: 'echo hello' });
    expect(result.success).toBe(true);
  });

  test('still emits generic error when no mode field is present', () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 'n1' }));
    expect(error.issues[0].message).toContain('must have either');
  });
});

describe('dagNodeSchema — new Claude SDK options', () => {
  test('parses the strongest effort rung on a prompt node', () => {
    const result = dagNodeSchema.parse({ id: 'n', prompt: 'do it', effort: 'ultra' });
    expect((result as AgentNode).effort).toBe('ultra');
  });

  test.each([
    ['rejects invalid effort value', { id: 'n', prompt: 'do it', effort: 'extreme' }, false],
    ['rejects negative maxBudgetUsd', { id: 'n', prompt: 'do it', maxBudgetUsd: -1 }, false],
    ['rejects zero maxBudgetUsd', { id: 'n', prompt: 'do it', maxBudgetUsd: 0 }, false],
    ['rejects empty betas array', { id: 'n', prompt: 'do it', betas: [] }, false],
    ['rejects empty systemPrompt string', { id: 'n', prompt: 'do it', systemPrompt: '' }, false],
    [
      'rejects settingSources with invalid source value',
      {
        id: 'n',
        prompt: 'do it',
        settingSources: ['project', 'global'],
      },
      false,
    ],
    [
      'rejects non-array settingSources',
      {
        id: 'n',
        prompt: 'do it',
        settingSources: 'project',
      },
      false,
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(dagNodeSchema.safeParse(input).success).toBe(expected);
  });

  test('rejects retired thinking config and names effort', () => {
    const error = validationError(
      dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', thinking: 'adaptive' })
    );
    expect(error.issues[0]?.path).toEqual(['thinking']);
    expect(error.issues[0]?.message).toContain('effort:');
  });

  test('parses trimmed plugin ids and rejects an empty one', () => {
    const result = dagNodeSchema.parse({
      id: 'n',
      prompt: 'do it',
      plugins: [' formatter@tools '],
    });
    expect((result as AgentNode).plugins).toEqual(['formatter@tools']);
    expect(dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', plugins: ['  '] }).success).toBe(
      false
    );
  });

  test('parses maxBudgetUsd as positive number', () => {
    const result = dagNodeSchema.parse({ id: 'n', prompt: 'do it', maxBudgetUsd: 2.5 });
    expect((result as AgentNode).maxBudgetUsd).toBe(2.5);
  });

  test('parses betas array', () => {
    const result = dagNodeSchema.parse({
      id: 'n',
      prompt: 'do it',
      betas: ['context-1m-2025-08-07'],
    });
    expect((result as AgentNode).betas).toEqual(['context-1m-2025-08-07']);
  });

  test('parses sandbox object', () => {
    const result = dagNodeSchema.parse({
      id: 'n',
      prompt: 'do it',
      sandbox: { enabled: true, filesystem: { allowWrite: ['src/'] } },
    });
    expect((result as AgentNode).sandbox?.enabled).toBe(true);
  });

  test('parses systemPrompt string', () => {
    const result = dagNodeSchema.parse({
      id: 'n',
      prompt: 'do it',
      systemPrompt: 'You are a security reviewer',
    });
    expect((result as AgentNode).systemPrompt).toBe('You are a security reviewer');
  });

  test('parses fallbackModel string', () => {
    const result = dagNodeSchema.parse({
      id: 'n',
      prompt: 'do it',
      fallbackModel: 'claude-haiku-4-5-20251001',
    });
    expect((result as AgentNode).fallbackModel).toBe('claude-haiku-4-5-20251001');
  });

  test('parses settingSources array of valid sources', () => {
    const result = dagNodeSchema.parse({
      id: 'n',
      prompt: 'do it',
      settingSources: ['project'],
    });
    expect((result as AgentNode).settingSources).toEqual(['project']);
  });

  test('strips settingSources from bash nodes', () => {
    const result = dagNodeSchema.parse({
      id: 'b',
      bash: 'echo hi',
      settingSources: ['project'],
    });
    expect('settingSources' in result).toBe(false);
  });

  test('strips AI-only fields from bash nodes', () => {
    const result = dagNodeSchema.parse({
      id: 'b',
      bash: 'echo hi',
      effort: 'high',
    });
    expect('effort' in result).toBe(false);
  });
});

describe('dagNodeSchema — per-node Pi posture (pi:)', () => {
  test('accepts and preserves a pi: block on a prompt node', () => {
    const result = dagNodeSchema.parse({
      id: 'plan',
      prompt: 'plan it',
      pi: { interactive: true, extensionFlags: { plan: true, 'plan-file': 'PLAN.md' } },
    });
    expect((result as AgentNode).pi).toEqual({
      interactive: true,
      extensionFlags: { plan: true, 'plan-file': 'PLAN.md' },
    });
  });

  test('preserves a pi: block on a loop node (the plannotator leak seam, #2073)', () => {
    const result = dagNodeSchema.parse({
      id: 'implement',
      loop: { prompt: 'do work', until: 'DONE', max_iterations: 5 },
      pi: { interactive: false, extensionFlags: { plan: false } },
    });
    expect(isLoopNode(result as DagNode)).toBe(true);
    expect((result as DagNode & { pi?: unknown }).pi).toEqual({
      interactive: false,
      extensionFlags: { plan: false },
    });
  });

  test('drops pi: from a bash node in the transform', () => {
    const result = dagNodeSchema.parse({
      id: 'sh',
      bash: 'echo hi',
      pi: { interactive: false },
    });
    expect('pi' in result).toBe(false);
  });

  test('rejects a non-boolean/string extensionFlags value', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      prompt: 'plan it',
      pi: { extensionFlags: { plan: 42 } },
    });
    expect(result.success).toBe(false);
  });

  test('pi is warned-ignored on non-AI + loop_group nodes but supported on loop', () => {
    // loop uses its per-iteration sendQuery, so pi must NOT be in its ignore list;
    // loop_group never sendQuerys (body nodes carry their own pi), so it warns.
    expect(LOOP_NODE_AI_FIELDS).not.toContain('pi');
    expect(LOOP_GROUP_NODE_AI_FIELDS).toContain('pi');
    expect(SCRIPT_NODE_AI_FIELDS).toContain('pi');
  });
});

describe('dagNodeSchema — output_format survival by node type', () => {
  const outputFormat = { type: 'object', properties: { done: { type: 'boolean' } } };

  function parsedNode(extra: Record<string, unknown>) {
    const node = dagNodeSchema.parse({ id: 'n1', ...extra, output_format: outputFormat });
    if (!('output_format' in node)) throw new Error('Expected output_format');
    return node;
  }

  test('a loop node KEEPS output_format (#2563 — it runs its own sendQuery)', () => {
    expect(
      parsedNode({ loop: { until: 'DONE', max_iterations: 3, prompt: 'go' } }).output_format
    ).toEqual(outputFormat);
  });

  test('a loop_group node KEEPS output_format (aiOnly is spread)', () => {
    const node = parsedNode({
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'body', prompt: 'x' }] },
    });
    expect(node.output_format).toEqual(outputFormat);
  });

  test('prompt and command nodes KEEP output_format', () => {
    expect(parsedNode({ prompt: 'go' }).output_format).toEqual(outputFormat);
    expect(parsedNode({ command: 'some-command' }).output_format).toEqual(outputFormat);
  });
});

describe('dagNodeSchema — mutates_checkout tree-integrity declaration (#2771)', () => {
  test('parses a boolean on an exec node and carries it through the transform', () => {
    const result = dagNodeSchema.parse({
      id: 'guard',
      bash: 'echo hi',
      mutates_checkout: false,
    });
    expect('mutates_checkout' in result && result.mutates_checkout === false).toBe(true);
  });

  test('parses true and stays absent when undeclared', () => {
    const declared = dagNodeSchema.safeParse({ id: 'a', prompt: 'x', mutates_checkout: true });
    expect(
      declared.success &&
        'mutates_checkout' in declared.data &&
        declared.data.mutates_checkout === true
    ).toBe(true);
    const absent = dagNodeSchema.safeParse({ id: 'b', prompt: 'x' });
    expect(absent.success && !('mutates_checkout' in absent.data)).toBe(true);
  });

  test('rejects a non-boolean value', () => {
    const result = dagNodeSchema.safeParse({ id: 'a', bash: 'echo hi', mutates_checkout: 'no' });
    expect(result.success).toBe(false);
  });

  test('is warned as ignored on wait nodes, not silently stripped', () => {
    // The field parses into the base shape (so Zod does not drop it), but a wait's
    // lifecycle is engine-owned — the loader warns via WAIT_NODE_IGNORED_FIELDS.
    for (const f of ['mutates_checkout']) {
      expect(WAIT_NODE_IGNORED_FIELDS).toContain(f);
      expect(WORKFLOW_NODE_IGNORED_FIELDS).toContain(f);
      expect(BASH_NODE_AI_FIELDS).not.toContain(f); // enforced on exec/agent nodes
    }
  });
});
