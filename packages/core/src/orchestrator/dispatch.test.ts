/**
 * Tests for dispatch.ts — pure `defaultWorkflows:` routing policy.
 */

import { describe, test, expect } from 'bun:test';
import { resolveDispatch } from './dispatch';

describe('resolveDispatch', () => {
  const table = { 'acme/support-inbox': 'intake-workflow' };

  test('unlisted project passes through untouched, no notice', () => {
    const result = resolveDispatch('hello there', 'some/other-project', table, '* ');
    expect(result).toEqual({ kind: 'chat', message: 'hello there' });
  });

  test('no codebase name (unbound conversation) passes through untouched', () => {
    const result = resolveDispatch('hello there', undefined, table, '* ');
    expect(result).toEqual({ kind: 'chat', message: 'hello there' });
  });

  test('no defaultWorkflows table configured passes through untouched', () => {
    const result = resolveDispatch('hello there', 'acme/support-inbox', undefined, '* ');
    expect(result).toEqual({ kind: 'chat', message: 'hello there' });
  });

  test('plain message in a mapped project runs the default workflow', () => {
    const result = resolveDispatch('log this receipt', 'acme/support-inbox', table, '* ');
    expect(result).toEqual({
      kind: 'workflow',
      workflowName: 'intake-workflow',
      message: 'log this receipt',
    });
  });

  test('bypass sigil escapes to chat, prefix stripped, notice posted', () => {
    const result = resolveDispatch('* what did I log', 'acme/support-inbox', table, '* ');
    expect(result).toEqual({
      kind: 'chat',
      message: 'what did I log',
      notice: "Bypass sigil '* ' detected, bypassing default workflow: intake-workflow",
    });
  });

  test('bypass sigil with nothing after it passes the original message through', () => {
    const result = resolveDispatch('* ', 'acme/support-inbox', table, '* ');
    expect(result.kind).toBe('chat');
    expect((result as { message: string }).message).toBe('* ');
  });

  test('a message that merely contains the bypass text mid-string still dispatches', () => {
    const result = resolveDispatch('note: * urgent', 'acme/support-inbox', table, '* ');
    expect(result.kind).toBe('workflow');
  });

  test('leading whitespace before the bypass sigil still escapes', () => {
    const result = resolveDispatch('   * indented', 'acme/support-inbox', table, '* ');
    expect(result).toEqual({
      kind: 'chat',
      message: 'indented',
      notice: "Bypass sigil '* ' detected, bypassing default workflow: intake-workflow",
    });
  });

  test('a leading space in the configured bypass value is ignored (config typo tolerance)', () => {
    const result = resolveDispatch('* what did I log', 'acme/support-inbox', table, ' * ');
    expect(result).toEqual({
      kind: 'chat',
      message: 'what did I log',
      notice: "Bypass sigil '* ' detected, bypassing default workflow: intake-workflow",
    });
  });

  test('unset bypass config means the bypass rule never matches', () => {
    const result = resolveDispatch('* urgent note', 'acme/support-inbox', table, undefined);
    expect(result.kind).toBe('workflow');
  });

  test('empty-string bypass config is ignored, not honored as a match-everything prefix', () => {
    const result = resolveDispatch('anything', 'acme/support-inbox', table, '');
    expect(result.kind).toBe('workflow');
  });

  test('whitespace-only bypass config is ignored', () => {
    const result = resolveDispatch('anything', 'acme/support-inbox', table, '   ');
    expect(result.kind).toBe('workflow');
  });

  test('slash command bypasses to chat with a notice, message unchanged', () => {
    const result = resolveDispatch('/status', 'acme/support-inbox', table, '* ');
    expect(result).toEqual({
      kind: 'chat',
      message: '/status',
      notice: 'Command (slash) detected, bypassing default workflow: intake-workflow',
    });
  });

  test('a bare slash with no word characters does not count as a slash command', () => {
    const result = resolveDispatch('/', 'acme/support-inbox', table, '* ');
    expect(result.kind).toBe('workflow');
  });

  test('slash command bypasses even with no bypass sigil configured', () => {
    const result = resolveDispatch('/help me', 'acme/support-inbox', table, undefined);
    expect(result).toEqual({
      kind: 'chat',
      message: '/help me',
      notice: 'Command (slash) detected, bypassing default workflow: intake-workflow',
    });
  });

  test('a slash-command pattern anywhere in the message bypasses, not just at the start', () => {
    const result = resolveDispatch(
      'what do you know about /workflow list',
      'acme/support-inbox',
      table,
      '* '
    );
    expect(result).toEqual({
      kind: 'chat',
      message: 'what do you know about /workflow list',
      notice: 'Command (slash) detected, bypassing default workflow: intake-workflow',
    });
  });

  test('conversational text mentioning a slash command still bypasses', () => {
    const result = resolveDispatch('hey archon /workfloe list', 'acme/support-inbox', table, '* ');
    expect(result.kind).toBe('chat');
  });

  test('project keys match case-insensitively', () => {
    const result = resolveDispatch('log it', 'Acme/Support-Inbox', table, '* ');
    expect(result).toEqual({
      kind: 'workflow',
      workflowName: 'intake-workflow',
      message: 'log it',
    });
  });

  test('malformed table values (non-string) are ignored, falling through to chat', () => {
    const malformed = { 'acme/support-inbox': 123 } as unknown as Record<string, string>;
    const result = resolveDispatch('log it', 'acme/support-inbox', malformed, '* ');
    expect(result).toEqual({ kind: 'chat', message: 'log it' });
  });

  test('blank-string workflow name in the table is ignored', () => {
    const blank = { 'acme/support-inbox': '   ' };
    const result = resolveDispatch('log it', 'acme/support-inbox', blank, '* ');
    expect(result).toEqual({ kind: 'chat', message: 'log it' });
  });
});
