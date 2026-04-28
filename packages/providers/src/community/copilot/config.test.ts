import { describe, expect, test } from 'bun:test';
import { parseCopilotConfig } from './config';

describe('parseCopilotConfig', () => {
  test('parses supported fields', () => {
    expect(
      parseCopilotConfig({
        model: 'gpt-5',
        copilotCliPath: '/usr/local/bin/copilot',
        configDir: '/tmp/copilot',
        enableConfigDiscovery: true,
        useLoggedInUser: false,
        logLevel: 'debug',
      })
    ).toEqual({
      model: 'gpt-5',
      copilotCliPath: '/usr/local/bin/copilot',
      configDir: '/tmp/copilot',
      enableConfigDiscovery: true,
      useLoggedInUser: false,
      logLevel: 'debug',
    });
  });

  test('drops invalid values silently', () => {
    expect(
      parseCopilotConfig({
        model: 123,
        copilotCliPath: false,
        configDir: null,
        enableConfigDiscovery: 'yes',
        useLoggedInUser: 'no',
        logLevel: 'verbose',
      } as unknown as Record<string, unknown>)
    ).toEqual({});
  });
});
