import { afterEach, describe, expect, test } from 'bun:test';
import type { MessageChunk as SdkMessageChunk } from '@lrilai/gemini-cli-sdk';

import {
  translateChunk,
  translateOptions,
  resetWarnedKeys,
  warnIgnoredOptions,
} from './options-translator';

describe('translateChunk', () => {
  test('translates assistant chunk', () => {
    const chunk: SdkMessageChunk = { type: 'assistant', content: 'Hello' };
    expect(translateChunk(chunk)).toEqual({ type: 'assistant', content: 'Hello' });
  });

  test('translates thinking chunk', () => {
    const chunk: SdkMessageChunk = { type: 'thinking', content: 'reasoning...' };
    expect(translateChunk(chunk)).toEqual({ type: 'thinking', content: 'reasoning...' });
  });

  test('flattens system chunk into a readable string', () => {
    const chunk: SdkMessageChunk = {
      type: 'system',
      subtype: 'init',
      sessionId: 's1',
      model: 'gemini-2.5-pro',
    };
    const result = translateChunk(chunk);
    expect(result.type).toBe('system');
    if (result.type === 'system') {
      expect(result.content).toBe('init session=s1 model=gemini-2.5-pro');
    }
  });

  test('translates tool chunk — maps toolId→toolCallId, parameters→toolInput', () => {
    const chunk: SdkMessageChunk = {
      type: 'tool',
      toolName: 'bash',
      toolId: 'call-abc',
      parameters: { command: 'ls' },
    };
    expect(translateChunk(chunk)).toEqual({
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'ls' },
      toolCallId: 'call-abc',
    });
  });

  test('translates tool_result chunk — toolName is empty (SDK omits it)', () => {
    const chunk: SdkMessageChunk = {
      type: 'tool_result',
      toolId: 'call-abc',
      status: 'success',
      output: 'file1.ts',
    };
    const result = translateChunk(chunk);
    expect(result.type).toBe('tool_result');
    if (result.type === 'tool_result') {
      expect(result.toolName).toBe('');
      expect(result.toolOutput).toBe('file1.ts');
      expect(result.toolCallId).toBe('call-abc');
    }
  });

  test('tool_result with empty output falls back to stringified error', () => {
    const chunk: SdkMessageChunk = {
      type: 'tool_result',
      toolId: 'call-x',
      status: 'error',
      output: '',
      error: { message: 'Permission denied' },
    };
    const result = translateChunk(chunk);
    if (result.type === 'tool_result') {
      expect(result.toolOutput).toBe(JSON.stringify({ message: 'Permission denied' }));
    }
  });

  test('translates rate_limit chunk', () => {
    const chunk: SdkMessageChunk = {
      type: 'rate_limit',
      code: 429,
      message: 'quota exceeded',
      status: 'RESOURCE_EXHAUSTED',
    };
    expect(translateChunk(chunk)).toEqual({
      type: 'rate_limit',
      rateLimitInfo: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' },
    });
  });

  test('translates result chunk to sessionId + stopReason', () => {
    const chunk: SdkMessageChunk = {
      type: 'result',
      sessionId: 'ses-123',
      stopReason: 'end_turn',
    };
    expect(translateChunk(chunk)).toEqual({
      type: 'result',
      sessionId: 'ses-123',
      stopReason: 'end_turn',
    });
  });

  test('workflow_dispatch (reserved, never emitted) degrades to a system message', () => {
    const chunk: SdkMessageChunk = { type: 'workflow_dispatch' };
    const result = translateChunk(chunk);
    expect(result.type).toBe('system');
    if (result.type === 'system') {
      expect(result.content).toContain('workflow_dispatch');
    }
  });
});

describe('translateOptions', () => {
  test('sets approvalMode to yolo for headless execution', () => {
    const opts = translateOptions('hello', '/cwd', undefined, undefined, undefined);
    expect(opts.approvalMode).toBe('yolo');
    expect(opts.prompt).toBe('hello');
    expect(opts.cwd).toBe('/cwd');
  });

  test('passes model through', () => {
    const opts = translateOptions('hi', '/cwd', undefined, { model: 'gemini-2.5-pro' }, undefined);
    expect(opts.model).toBe('gemini-2.5-pro');
  });

  test('passes resumeSessionId as session', () => {
    const opts = translateOptions('hi', '/cwd', 'ses-999', undefined, undefined);
    expect(opts.session).toBe('ses-999');
  });

  test('omits session when resumeSessionId is undefined', () => {
    const opts = translateOptions('hi', '/cwd', undefined, undefined, undefined);
    expect(opts.session).toBeUndefined();
  });

  test('forwards env without injecting HOME (subprocess inherits it)', () => {
    const opts = translateOptions('hi', '/cwd', undefined, { env: { MY_VAR: 'value' } }, undefined);
    expect(opts.env?.MY_VAR).toBe('value');
    expect(opts.env?.HOME).toBeUndefined();
  });

  test('passes cliPath from the binary resolver', () => {
    const opts = translateOptions('hi', '/cwd', undefined, undefined, '/usr/local/bin/gemini');
    expect(opts.cliPath).toBe('/usr/local/bin/gemini');
  });

  test('omits cliPath when undefined', () => {
    const opts = translateOptions('hi', '/cwd', undefined, undefined, undefined);
    expect(opts.cliPath).toBeUndefined();
  });

  test('maps nodeConfig.allowed_tools → allowedTools', () => {
    const opts = translateOptions(
      'hi',
      '/cwd',
      undefined,
      { nodeConfig: { allowed_tools: ['bash', 'read'] } },
      undefined
    );
    expect(opts.allowedTools).toEqual(['bash', 'read']);
  });

  test('systemPrompt: top-level wins over nodeConfig', () => {
    const opts = translateOptions(
      'hi',
      '/cwd',
      undefined,
      { systemPrompt: 'top-level', nodeConfig: { systemPrompt: 'node-level' } },
      undefined
    );
    expect(opts.systemPrompt).toBe('top-level');
  });

  test('systemPrompt falls back to nodeConfig when top-level absent', () => {
    const opts = translateOptions(
      'hi',
      '/cwd',
      undefined,
      { nodeConfig: { systemPrompt: 'node-level' } },
      undefined
    );
    expect(opts.systemPrompt).toBe('node-level');
  });

  test('drops a non-string (preset) systemPrompt', () => {
    const opts = translateOptions(
      'hi',
      '/cwd',
      undefined,
      { systemPrompt: { type: 'preset', preset: 'claude_code' } },
      undefined
    );
    expect(opts.systemPrompt).toBeUndefined();
  });
});

describe('warnIgnoredOptions', () => {
  afterEach(() => resetWarnedKeys());

  test('does not throw when options contain ignored fields', () => {
    expect(() =>
      warnIgnoredOptions({ maxBudgetUsd: 5, nodeConfig: { mcp: 'x.json' } })
    ).not.toThrow();
  });

  test('does not throw for undefined options', () => {
    expect(() => warnIgnoredOptions(undefined)).not.toThrow();
  });
});
