// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { isExecNode, isHaltNode, isTriggerRule, TRIGGER_RULES } from './schemas';
import type { AgentNode, ExecNode, HaltNode, TriggerRule } from './schemas';

const commandNode: AgentNode = {
  id: 'n1',
  kind: 'agent',
  source: { kind: 'command', name: 'build' },
};
const promptNode: AgentNode = {
  id: 'n2',
  kind: 'agent',
  source: { kind: 'inline', prompt: 'Do this inline.' },
};
const bashNode: ExecNode = { id: 'n3', kind: 'exec', runtime: 'sh', script: 'echo hello' };
const cancelNode: HaltNode = { id: 'n5', kind: 'halt', reason: 'Precondition failed' };

describe('isExecNode', () => {
  test('returns true for a sh-runtime (formerly bash) node', () => {
    expect(isExecNode(bashNode)).toBe(true);
  });

  test('returns true for a sh-runtime node with timeout', () => {
    const withTimeout: ExecNode = { ...bashNode, script: 'npm test', timeout: 60000 };
    expect(isExecNode(withTimeout)).toBe(true);
  });

  test('returns true for a sh-runtime node with depends_on', () => {
    const withDeps: ExecNode = { ...bashNode, script: 'echo done', depends_on: ['n1'] };
    expect(isExecNode(withDeps)).toBe(true);
  });

  test('returns true for a bun-runtime (formerly script) node', () => {
    const scriptNode: ExecNode = {
      id: 's1',
      kind: 'exec',
      runtime: 'bun',
      script: 'console.log("hi")',
    };
    expect(isExecNode(scriptNode)).toBe(true);
  });

  test('returns true for a script node with deps', () => {
    const withDeps: ExecNode = {
      id: 's',
      kind: 'exec',
      runtime: 'bun',
      script: 'import zod from "zod"',
      deps: ['zod'],
    };
    expect(isExecNode(withDeps)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isExecNode(commandNode)).toBe(false);
  });

  test('returns false for an AgentNode', () => {
    expect(isExecNode(promptNode)).toBe(false);
  });
});

describe('isHaltNode', () => {
  test('returns true for a HaltNode', () => {
    expect(isHaltNode(cancelNode)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isHaltNode(commandNode)).toBe(false);
  });

  test('returns false for an AgentNode', () => {
    expect(isHaltNode(promptNode)).toBe(false);
  });

  test('returns false for an ExecNode', () => {
    expect(isHaltNode(bashNode)).toBe(false);
  });
});

describe('isTriggerRule', () => {
  test('returns true for all canonical trigger rules', () => {
    const rules: string[] = [...TRIGGER_RULES];
    for (const rule of rules) {
      expect(isTriggerRule(rule)).toBe(true);
    }
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
      const rule: TriggerRule = value;
      expect(rule).toBe('all_success');
    } else {
      expect(true).toBe(false);
    }
  });
});

describe('TRIGGER_RULES', () => {
  test('contains exactly four entries', () => {
    expect(TRIGGER_RULES).toHaveLength(4);
  });

  test('all entries are strings', () => {
    for (const rule of TRIGGER_RULES) {
      expect(typeof rule).toBe('string');
    }
  });

  test('contains the supported trigger rule vocabulary', () => {
    expect(TRIGGER_RULES).toContain('all_success');
    expect(TRIGGER_RULES).toContain('one_success');
    expect(TRIGGER_RULES).toContain('none_failed_min_one_success');
    expect(TRIGGER_RULES).toContain('all_done');
  });
});
