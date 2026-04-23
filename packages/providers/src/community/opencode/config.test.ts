import { describe, test, expect } from 'bun:test';
import { parseOpencodeConfig } from './config';

describe('parseOpencodeConfig', () => {
  test('returns empty object for empty input', () => {
    const result = parseOpencodeConfig({});
    expect(result).toEqual({});
  });

  test('parses model string', () => {
    const result = parseOpencodeConfig({ model: 'anthropic/claude-sonnet-4' });
    expect(result.model).toBe('anthropic/claude-sonnet-4');
  });

  test('parses hostname', () => {
    const result = parseOpencodeConfig({ hostname: '0.0.0.0' });
    expect(result.hostname).toBe('0.0.0.0');
  });

  test('parses port', () => {
    const result = parseOpencodeConfig({ port: 8080 });
    expect(result.port).toBe(8080);
  });

  test('parses serverPassword', () => {
    const result = parseOpencodeConfig({ serverPassword: 'secret123' });
    expect(result.serverPassword).toBe('secret123');
  });

  test('parses autoStartServer', () => {
    const result = parseOpencodeConfig({ autoStartServer: false });
    expect(result.autoStartServer).toBe(false);
  });

  test('ignores invalid fields', () => {
    const result = parseOpencodeConfig({
      model: 'anthropic/claude-sonnet-4',
      port: 'not-a-number',
      autoStartServer: 'yes',
      unknownField: 'ignored',
    } as Record<string, unknown>);
    expect(result.model).toBe('anthropic/claude-sonnet-4');
    expect(result.port).toBeUndefined();
    expect(result.autoStartServer).toBeUndefined();
    expect(result.unknownField).toBeUndefined();
  });

  test('parses full config', () => {
    const result = parseOpencodeConfig({
      model: 'openai/gpt-5',
      hostname: '127.0.0.1',
      port: 4096,
      serverPassword: 'my-password',
      autoStartServer: true,
    });
    expect(result).toEqual({
      model: 'openai/gpt-5',
      hostname: '127.0.0.1',
      port: 4096,
      serverPassword: 'my-password',
      autoStartServer: true,
    });
  });
});
