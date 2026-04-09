import { describe, test, expect } from 'bun:test';
import {
  isBashNode,
  isCancelNode,
  isScriptNode,
  isTriggerRule,
  TRIGGER_RULES,
  SCRIPT_NODE_AI_FIELDS,
  approvalOnRejectSchema,
  dagNodeSchema,
} from './schemas';
import type {
  WorkflowDefinition,
  DagNode,
  CommandNode,
  PromptNode,
  BashNode,
  CancelNode,
  ScriptNode,
  TriggerRule,
} from './schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const commandNode: CommandNode = { id: 'n1', command: 'build' };
const promptNode: PromptNode = { id: 'n2', prompt: 'Do this inline.' };
const bashNode: BashNode = { id: 'n3', bash: 'echo hello' };
const cancelNode: CancelNode = { id: 'n5', cancel: 'Precondition failed' };

const dagWorkflow: WorkflowDefinition = {
  name: 'dag-workflow',
  description: 'DAG execution',
  nodes: [commandNode, promptNode, bashNode],
};

// ---------------------------------------------------------------------------
// isBashNode
// ---------------------------------------------------------------------------

describe('isBashNode', () => {
  test('returns true for a BashNode', () => {
    expect(isBashNode(bashNode)).toBe(true);
  });

  test('returns true for a BashNode with timeout', () => {
    const withTimeout: BashNode = { id: 'b', bash: 'npm test', timeout: 60000 };
    expect(isBashNode(withTimeout)).toBe(true);
  });

  test('returns true for a BashNode with depends_on', () => {
    const withDeps: BashNode = { id: 'b', bash: 'echo done', depends_on: ['n1'] };
    expect(isBashNode(withDeps)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isBashNode(commandNode)).toBe(false);
  });

  test('returns false for a PromptNode', () => {
    expect(isBashNode(promptNode)).toBe(false);
  });

  test('returns false when bash field is missing', () => {
    const noCmd = { id: 'x', command: 'build' } as DagNode;
    expect(isBashNode(noCmd)).toBe(false);
  });

  test('returns false when bash is not a string (malformed node)', () => {
    // Deliberately violate the type to ensure the runtime check catches it
    const malformed = { id: 'x', bash: 42 } as unknown as DagNode;
    expect(isBashNode(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCancelNode
// ---------------------------------------------------------------------------

describe('isCancelNode', () => {
  test('returns true for a CancelNode', () => {
    expect(isCancelNode(cancelNode)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isCancelNode(commandNode)).toBe(false);
  });

  test('returns false for a PromptNode', () => {
    expect(isCancelNode(promptNode)).toBe(false);
  });

  test('returns false for a BashNode', () => {
    expect(isCancelNode(bashNode)).toBe(false);
  });

  test('returns false when cancel is not a string (malformed node)', () => {
    const malformed = { id: 'x', cancel: 42 } as unknown as DagNode;
    expect(isCancelNode(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTriggerRule
// ---------------------------------------------------------------------------

describe('isTriggerRule', () => {
  test('returns true for all canonical trigger rules', () => {
    const rules: string[] = [...TRIGGER_RULES];
    for (const rule of rules) {
      expect(isTriggerRule(rule)).toBe(true);
    }
  });

  test('returns true for "all_success"', () => {
    expect(isTriggerRule('all_success')).toBe(true);
  });

  test('returns true for "one_success"', () => {
    expect(isTriggerRule('one_success')).toBe(true);
  });

  test('returns true for "none_failed_min_one_success"', () => {
    expect(isTriggerRule('none_failed_min_one_success')).toBe(true);
  });

  test('returns true for "all_done"', () => {
    expect(isTriggerRule('all_done')).toBe(true);
  });

  test('returns false for an unknown string', () => {
    expect(isTriggerRule('any_success')).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isTriggerRule('')).toBe(false);
  });

  test('returns false for a number', () => {
    expect(isTriggerRule(1)).toBe(false);
  });

  test('returns false for null', () => {
    expect(isTriggerRule(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isTriggerRule(undefined)).toBe(false);
  });

  test('returns false for an object', () => {
    expect(isTriggerRule({})).toBe(false);
  });

  test('is used as a TriggerRule type after guard (compile-time verification)', () => {
    const value: unknown = 'all_success';
    if (isTriggerRule(value)) {
      // TypeScript should narrow value to TriggerRule here
      const rule: TriggerRule = value;
      expect(rule).toBe('all_success');
    } else {
      // Should not reach here
      expect(true).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TRIGGER_RULES constant
// ---------------------------------------------------------------------------

describe('TRIGGER_RULES', () => {
  test('contains exactly four entries', () => {
    expect(TRIGGER_RULES).toHaveLength(4);
  });

  test('all entries are strings', () => {
    for (const rule of TRIGGER_RULES) {
      expect(typeof rule).toBe('string');
    }
  });

  test('is readonly (does not expose mutation methods at runtime)', () => {
    // The readonly modifier is enforced at compile time; at runtime it's a plain array.
    // Verify the values are stable and match expectations.
    expect(TRIGGER_RULES).toContain('all_success');
    expect(TRIGGER_RULES).toContain('one_success');
    expect(TRIGGER_RULES).toContain('none_failed_min_one_success');
    expect(TRIGGER_RULES).toContain('all_done');
  });
});

// ---------------------------------------------------------------------------
// approvalOnRejectSchema
// ---------------------------------------------------------------------------

describe('approvalOnRejectSchema', () => {
  test('accepts valid on_reject config', () => {
    const result = approvalOnRejectSchema.safeParse({
      prompt: 'Fix: $REJECTION_REASON',
      max_attempts: 3,
    });
    expect(result.success).toBe(true);
  });

  test('accepts on_reject without max_attempts (uses default)', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: 'Please revise' });
    expect(result.success).toBe(true);
  });

  test('rejects empty prompt', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('on_reject.prompt');
  });

  test('rejects max_attempts: 0', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: 'Fix it', max_attempts: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects max_attempts: 11', () => {
    const result = approvalOnRejectSchema.safeParse({ prompt: 'Fix it', max_attempts: 11 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — empty bash/prompt validation
// ---------------------------------------------------------------------------

describe('dagNodeSchema — empty bash/prompt', () => {
  test('emits "bash script cannot be empty" for bash: ""', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('bash script cannot be empty');
    }
  });

  test('emits "bash script cannot be empty" for whitespace-only bash', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('bash script cannot be empty');
    }
  });

  test('emits "prompt cannot be empty" for prompt: ""', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', prompt: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('prompt cannot be empty');
    }
  });

  test('emits "prompt cannot be empty" for whitespace-only prompt', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', prompt: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('prompt cannot be empty');
    }
  });

  test('passes for bash: "echo hello"', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1', bash: 'echo hello' });
    expect(result.success).toBe(true);
  });

  test('still emits generic error when no mode field is present', () => {
    const result = dagNodeSchema.safeParse({ id: 'n1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('must have either');
    }
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — Claude SDK options
// ---------------------------------------------------------------------------

describe('dagNodeSchema — new Claude SDK options', () => {
  test('parses effort enum on prompt node', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', effort: 'high' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as PromptNode).effort).toBe('high');
  });

  test('rejects invalid effort value', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', effort: 'ultra' });
    expect(result.success).toBe(false);
  });

  test('parses thinking string shorthand: adaptive', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', thinking: 'adaptive' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as PromptNode).thinking).toEqual({ type: 'adaptive' });
  });

  test('parses thinking string shorthand: disabled', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', thinking: 'disabled' });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as PromptNode).thinking).toEqual({ type: 'disabled' });
  });

  test('parses thinking object form with budgetTokens', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      thinking: { type: 'enabled', budgetTokens: 8000 },
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as PromptNode).thinking).toEqual({
        type: 'enabled',
        budgetTokens: 8000,
      });
  });

  test('rejects invalid thinking value', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', thinking: 'quantum' });
    expect(result.success).toBe(false);
  });

  test('parses maxBudgetUsd as positive number', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', maxBudgetUsd: 2.5 });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as PromptNode).maxBudgetUsd).toBe(2.5);
  });

  test('rejects negative maxBudgetUsd', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', maxBudgetUsd: -1 });
    expect(result.success).toBe(false);
  });

  test('rejects zero maxBudgetUsd', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', maxBudgetUsd: 0 });
    expect(result.success).toBe(false);
  });

  test('parses betas array', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      betas: ['context-1m-2025-08-07'],
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as PromptNode).betas).toEqual(['context-1m-2025-08-07']);
  });

  test('rejects empty betas array', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', betas: [] });
    expect(result.success).toBe(false);
  });

  test('parses sandbox object', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      sandbox: { enabled: true, filesystem: { allowWrite: ['src/'] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as PromptNode).sandbox?.enabled).toBe(true);
    }
  });

  test('parses systemPrompt string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      systemPrompt: 'You are a security reviewer',
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as PromptNode).systemPrompt).toBe('You are a security reviewer');
  });

  test('rejects empty systemPrompt string', () => {
    const result = dagNodeSchema.safeParse({ id: 'n', prompt: 'do it', systemPrompt: '' });
    expect(result.success).toBe(false);
  });

  test('parses fallbackModel string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n',
      prompt: 'do it',
      fallbackModel: 'claude-haiku-4-5-20251001',
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as PromptNode).fallbackModel).toBe('claude-haiku-4-5-20251001');
  });

  test('strips AI-only fields from bash nodes', () => {
    const result = dagNodeSchema.safeParse({
      id: 'b',
      bash: 'echo hi',
      effort: 'high',
      thinking: 'adaptive',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // bash nodes don't get AI-only fields in the transform
      expect('effort' in result.data).toBe(false);
      expect('thinking' in result.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isScriptNode
// ---------------------------------------------------------------------------

describe('isScriptNode', () => {
  const scriptNode: ScriptNode = { id: 's1', script: 'console.log("hi")', runtime: 'bun' };
  const commandNode: CommandNode = { id: 'n1', command: 'build' };
  const promptNode: PromptNode = { id: 'n2', prompt: 'Do this inline.' };
  const bashNode: BashNode = { id: 'n3', bash: 'echo hello' };

  test('returns true for a ScriptNode', () => {
    expect(isScriptNode(scriptNode)).toBe(true);
  });

  test('returns true for a ScriptNode with deps', () => {
    const withDeps: ScriptNode = {
      id: 's',
      script: 'import zod from "zod"',
      runtime: 'bun',
      deps: ['zod'],
    };
    expect(isScriptNode(withDeps)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isScriptNode(commandNode)).toBe(false);
  });

  test('returns false for a PromptNode', () => {
    expect(isScriptNode(promptNode)).toBe(false);
  });

  test('returns false for a BashNode', () => {
    expect(isScriptNode(bashNode)).toBe(false);
  });

  test('returns false when script is not a string (malformed node)', () => {
    const malformed = { id: 'x', script: 42 } as unknown as DagNode;
    expect(isScriptNode(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dagNodeSchema — ScriptNode parsing and validation
// ---------------------------------------------------------------------------

describe('dagNodeSchema — ScriptNode', () => {
  test('parses a bun script node with inline script', () => {
    const result = dagNodeSchema.safeParse({
      id: 'fetch',
      script: 'console.log("hello")',
      runtime: 'bun',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isScriptNode(result.data)).toBe(true);
      const node = result.data as ScriptNode;
      expect(node.script).toBe('console.log("hello")');
      expect(node.runtime).toBe('bun');
    }
  });

  test('parses a uv script node with inline script', () => {
    const result = dagNodeSchema.safeParse({
      id: 'py',
      script: 'print("hello")',
      runtime: 'uv',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isScriptNode(result.data)).toBe(true);
      const node = result.data as ScriptNode;
      expect(node.runtime).toBe('uv');
    }
  });

  test('parses a script node with deps', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'import httpx',
      runtime: 'uv',
      deps: ['httpx', 'beautifulsoup4'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ScriptNode;
      expect(node.deps).toEqual(['httpx', 'beautifulsoup4']);
    }
  });

  test('parses a script node with timeout', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      timeout: 30000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ScriptNode;
      expect(node.timeout).toBe(30000);
    }
  });

  test('parses a script node with depends_on', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      depends_on: ['prev'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as ScriptNode;
      expect(node.depends_on).toEqual(['prev']);
    }
  });

  test('rejects script node without runtime', () => {
    const result = dagNodeSchema.safeParse({ id: 's', script: 'console.log("hi")' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('runtime');
    }
  });

  test('rejects invalid runtime value', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'node',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty script string', () => {
    const result = dagNodeSchema.safeParse({ id: 's', script: '', runtime: 'bun' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('script cannot be empty');
    }
  });

  test('rejects whitespace-only script', () => {
    const result = dagNodeSchema.safeParse({ id: 's', script: '   ', runtime: 'bun' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('script cannot be empty');
    }
  });

  test('rejects negative timeout on script node', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      timeout: -1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects script + bash (mutually exclusive)', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      bash: 'echo hi',
      runtime: 'bun',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('rejects script + prompt (mutually exclusive)', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      prompt: 'Do something',
      runtime: 'bun',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('rejects script + command (mutually exclusive)', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      command: 'some-command',
      runtime: 'bun',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('strips AI-only fields from script nodes', () => {
    const result = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log("hi")',
      runtime: 'bun',
      effort: 'high',
      thinking: 'adaptive',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('effort' in result.data).toBe(false);
      expect('thinking' in result.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SCRIPT_NODE_AI_FIELDS constant
// ---------------------------------------------------------------------------

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
      'output_format',
      'allowed_tools',
      'denied_tools',
      'hooks',
      'mcp',
      'skills',
      'effort',
      'thinking',
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
});
