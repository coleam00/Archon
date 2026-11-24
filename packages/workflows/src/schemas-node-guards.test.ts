// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { isExecNode, isHaltNode } from './schemas';
import type { AgentNode, ExecNode, HaltNode } from './schemas';

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

  test('returns true for a bun-runtime (formerly script) node', () => {
    const scriptNode: ExecNode = {
      id: 's1',
      kind: 'exec',
      runtime: 'bun',
      script: 'console.log("hi")',
    };
    expect(isExecNode(scriptNode)).toBe(true);
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

  test('returns false for an AgentNode', () => {
    expect(isHaltNode(promptNode)).toBe(false);
  });
});
