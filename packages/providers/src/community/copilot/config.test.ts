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

  test('normalizes Archon alias `max` to SDK `xhigh`', () => {
    expect(parseCopilotConfig({ modelReasoningEffort: 'max' })).toEqual({
      modelReasoningEffort: 'xhigh',
    });
  });

  test('parses copilotCliPath string', () => {
    expect(parseCopilotConfig({ copilotCliPath: '/usr/local/bin/copilot' })).toEqual({
      copilotCliPath: '/usr/local/bin/copilot',
    });
  });

  test('drops non-string copilotCliPath', () => {
    expect(parseCopilotConfig({ copilotCliPath: 42 })).toEqual({});
  });

  test('parses configDir string', () => {
    expect(parseCopilotConfig({ configDir: '/tmp/copilot-config' })).toEqual({
      configDir: '/tmp/copilot-config',
    });
  });

  test('parses enableConfigDiscovery boolean', () => {
    expect(parseCopilotConfig({ enableConfigDiscovery: true })).toEqual({
      enableConfigDiscovery: true,
    });
    expect(parseCopilotConfig({ enableConfigDiscovery: false })).toEqual({
      enableConfigDiscovery: false,
    });
  });

  test('drops non-boolean enableConfigDiscovery', () => {
    expect(parseCopilotConfig({ enableConfigDiscovery: 'yes' })).toEqual({});
    expect(parseCopilotConfig({ enableConfigDiscovery: 1 })).toEqual({});
  });

  test('parses useLoggedInUser boolean', () => {
    expect(parseCopilotConfig({ useLoggedInUser: true })).toEqual({ useLoggedInUser: true });
    expect(parseCopilotConfig({ useLoggedInUser: false })).toEqual({ useLoggedInUser: false });
  });

  test('parses each valid logLevel enum', () => {
    for (const v of ['none', 'error', 'warning', 'info', 'debug', 'all'] as const) {
      expect(parseCopilotConfig({ logLevel: v })).toEqual({ logLevel: v });
    }
  });

  test('drops invalid logLevel', () => {
    expect(parseCopilotConfig({ logLevel: 'verbose' })).toEqual({});
    expect(parseCopilotConfig({ logLevel: 42 })).toEqual({});
  });

  test('ignores unknown keys', () => {
    expect(parseCopilotConfig({ futureField: 'x', model: 'gpt-5' })).toEqual({
      model: 'gpt-5',
    });
  });

  test('does not throw on malformed input', () => {
    expect(() => parseCopilotConfig({ model: null })).not.toThrow();
    expect(() => parseCopilotConfig({ modelReasoningEffort: {} })).not.toThrow();
    expect(() => parseCopilotConfig({ logLevel: null })).not.toThrow();
  });

  test('combines all fields', () => {
    expect(
      parseCopilotConfig({
        model: 'gpt-5-mini',
        modelReasoningEffort: 'high',
        copilotCliPath: '/bin/copilot',
        configDir: '/etc/copilot',
        enableConfigDiscovery: true,
        useLoggedInUser: false,
        logLevel: 'debug',
      })
    ).toEqual({
      model: 'gpt-5-mini',
      modelReasoningEffort: 'high',
      copilotCliPath: '/bin/copilot',
      configDir: '/etc/copilot',
      enableConfigDiscovery: true,
      useLoggedInUser: false,
      logLevel: 'debug',
    });
  });
});
