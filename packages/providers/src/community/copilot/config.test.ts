import { describe, expect, test } from 'bun:test';

import { parseCopilotConfig } from './config';

describe('parseCopilotConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseCopilotConfig({})).toEqual({});
  });

  test('parses valid model string', () => {
    expect(parseCopilotConfig({ model: 'gpt-5' })).toEqual({ model: 'gpt-5' });
  });

  test('drops non-string model silently', () => {
    expect(parseCopilotConfig({ model: 123 })).toEqual({});
    expect(parseCopilotConfig({ model: null })).toEqual({});
    expect(parseCopilotConfig({ model: [] })).toEqual({});
  });

  test('parses each valid reasoning effort value', () => {
    for (const v of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(parseCopilotConfig({ modelReasoningEffort: v })).toEqual({
        modelReasoningEffort: v,
      });
    }
  });

  test('drops unknown reasoning effort value', () => {
    expect(parseCopilotConfig({ modelReasoningEffort: 'minimal' })).toEqual({});
    expect(parseCopilotConfig({ modelReasoningEffort: 'extreme' })).toEqual({});
    expect(parseCopilotConfig({ modelReasoningEffort: 42 })).toEqual({});
  });

  test('parses githubToken string', () => {
    expect(parseCopilotConfig({ githubToken: 'ghp_secret' })).toEqual({
      githubToken: 'ghp_secret',
    });
  });

  test('drops non-string githubToken', () => {
    expect(parseCopilotConfig({ githubToken: 42 })).toEqual({});
  });

  test('parses cliPath string', () => {
    expect(parseCopilotConfig({ cliPath: '/usr/local/bin/copilot' })).toEqual({
      cliPath: '/usr/local/bin/copilot',
    });
  });

  test('parses systemMessage with content only (defaults mode to append)', () => {
    expect(parseCopilotConfig({ systemMessage: { content: 'Be concise.' } })).toEqual({
      systemMessage: { content: 'Be concise.', mode: 'append' },
    });
  });

  test('parses systemMessage with valid mode values', () => {
    for (const mode of ['append', 'replace', 'customize'] as const) {
      expect(parseCopilotConfig({ systemMessage: { content: 'x', mode } })).toEqual({
        systemMessage: { content: 'x', mode },
      });
    }
  });

  test('falls back to append mode when systemMessage.mode is invalid', () => {
    expect(parseCopilotConfig({ systemMessage: { content: 'x', mode: 'bogus' } })).toEqual({
      systemMessage: { content: 'x', mode: 'append' },
    });
  });

  test('drops systemMessage without content', () => {
    expect(parseCopilotConfig({ systemMessage: {} })).toEqual({});
    expect(parseCopilotConfig({ systemMessage: { mode: 'replace' } })).toEqual({});
  });

  test('drops array systemMessage (must be object)', () => {
    expect(parseCopilotConfig({ systemMessage: ['a', 'b'] })).toEqual({});
  });

  test('ignores unknown keys', () => {
    expect(parseCopilotConfig({ futureField: 'x', model: 'gpt-5' })).toEqual({
      model: 'gpt-5',
    });
  });

  test('does not throw on malformed input', () => {
    expect(() => parseCopilotConfig({ model: null })).not.toThrow();
    expect(() => parseCopilotConfig({ systemMessage: null })).not.toThrow();
    expect(() => parseCopilotConfig({ modelReasoningEffort: {} })).not.toThrow();
  });

  test('combines all fields', () => {
    expect(
      parseCopilotConfig({
        model: 'gpt-5-mini',
        modelReasoningEffort: 'high',
        githubToken: 'ghp_token',
        cliPath: '/bin/copilot',
        systemMessage: { content: 'Hi.', mode: 'replace' },
      })
    ).toEqual({
      model: 'gpt-5-mini',
      modelReasoningEffort: 'high',
      githubToken: 'ghp_token',
      cliPath: '/bin/copilot',
      systemMessage: { content: 'Hi.', mode: 'replace' },
    });
  });
});
