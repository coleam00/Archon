import { describe, expect, test } from 'bun:test';

import {
  parseCopilotConfig,
  parseCopilotConfigStrict,
  type CopilotProviderDefaults,
} from './config';

describe('parseCopilotConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseCopilotConfig({})).toEqual({});
  });

  test('drops non-string model silently', () => {
    expect(parseCopilotConfig({ model: 123 })).toEqual({});
    expect(parseCopilotConfig({ model: null })).toEqual({});
    expect(parseCopilotConfig({ model: [] })).toEqual({});
  });

  test('drops unknown reasoning effort value', () => {
    expect(parseCopilotConfig({ modelReasoningEffort: 'extreme' })).toEqual({});
    expect(parseCopilotConfig({ modelReasoningEffort: 42 })).toEqual({});
  });

  test('clamps the rungs Archon has and the SDK does not', () => {
    expect(parseCopilotConfig({ modelReasoningEffort: 'persistent' })).toEqual({
      modelReasoningEffort: 'max',
    });
    expect(parseCopilotConfig({ modelReasoningEffort: 'minimal' })).toEqual({
      modelReasoningEffort: 'low',
    });
  });

  test('drops non-string copilotCliPath', () => {
    expect(parseCopilotConfig({ copilotCliPath: 42 })).toEqual({});
  });

  test('drops non-boolean enableConfigDiscovery', () => {
    expect(parseCopilotConfig({ enableConfigDiscovery: 'yes' })).toEqual({});
    expect(parseCopilotConfig({ enableConfigDiscovery: 1 })).toEqual({});
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

  test('validates every setting and snapshots only portable settings', () => {
    const config = {
      model: 'gpt-5-mini',
      modelReasoningEffort: 'high',
      copilotCliPath: '/bin/copilot',
      configDir: '/etc/copilot',
      enableConfigDiscovery: true,
      useLoggedInUser: false,
      logLevel: 'debug',
    } satisfies Required<CopilotProviderDefaults>;
    expect(parseCopilotConfig(config)).toEqual(config);
    expect(parseCopilotConfigStrict(config)).toEqual(config);
    expect(parseCopilotConfigStrict(config, 'snapshot')).toEqual({
      model: 'gpt-5-mini',
      modelReasoningEffort: 'high',
    });
    expect(() => parseCopilotConfigStrict({ ...config, configDir: 42 }, 'snapshot')).toThrow();
  });
});
