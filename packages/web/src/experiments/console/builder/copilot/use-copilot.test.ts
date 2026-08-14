/**
 * Regression tests for the Copilot's tool-call matcher.
 *
 * The hook itself needs a React renderer (the console keeps a no-DOM test rule),
 * so only the pure matcher is exercised here — which is precisely where the bug
 * was: the Proposal was matched with `name === 'propose_workflow_edits'`, but
 * Claude persists in-process native tools under an MCP-namespaced name, so the
 * Proposal never surfaced on Claude at all. Every other unit test passed because
 * they cover the pure op/preview functions, never the delivery path.
 */
import { describe, expect, test } from 'bun:test';
import { isProposeToolCall } from './use-copilot';

describe('isProposeToolCall', () => {
  test('matches the MCP-namespaced name Claude actually persists', () => {
    // Verbatim from a live Claude turn's message metadata.
    expect(isProposeToolCall('mcp__archon__propose_workflow_edits')).toBe(true);
  });

  test('matches the bare name Pi persists', () => {
    expect(isProposeToolCall('propose_workflow_edits')).toBe(true);
  });

  test('tolerates a different in-process server name', () => {
    expect(isProposeToolCall('mcp__somethingelse__propose_workflow_edits')).toBe(true);
  });

  test.each([
    ['manage_run'],
    ['mcp__archon__manage_run'],
    ['propose_workflow_edits_v2'],
    ['Bash'],
    [''],
  ])('does not match %p', name => {
    expect(isProposeToolCall(name)).toBe(false);
  });
});
