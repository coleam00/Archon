import { mock, describe, it, expect, beforeEach } from 'bun:test';
import type { Logger } from 'pino';

// Mock logger — must be set up before importing any @archon/paths consumer
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
} as unknown as Logger;

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { parseAiderdeskConfig } from './config';

describe('parseAiderdeskConfig', () => {
  it('returns empty object for empty input', () => {
    const result = parseAiderdeskConfig({});
    expect(result).toEqual({});
  });

  it('parses valid model string', () => {
    const result = parseAiderdeskConfig({ model: 'ollama/qwen3-coder:30b' });
    expect(result.model).toBe('ollama/qwen3-coder:30b');
  });

  it('parses valid apiUrl string', () => {
    const result = parseAiderdeskConfig({ apiUrl: 'http://localhost:24337' });
    expect(result.apiUrl).toBe('http://localhost:24337');
  });

  it('parses valid agentProfileId string', () => {
    const result = parseAiderdeskConfig({ agentProfileId: 'profile-123' });
    expect(result.agentProfileId).toBe('profile-123');
  });

  it('parses valid mode', () => {
    for (const mode of ['code', 'ask', 'architect', 'context', 'agent'] as const) {
      const result = parseAiderdeskConfig({ mode });
      expect(result.mode).toBe(mode);
    }
  });

  it('drops invalid mode silently', () => {
    const result = parseAiderdeskConfig({ mode: 'invalid_mode' });
    expect(result.mode).toBeUndefined();
  });

  it('parses valid pollIntervalMs', () => {
    const result = parseAiderdeskConfig({ pollIntervalMs: 1000 });
    expect(result.pollIntervalMs).toBe(1000);
  });

  it('drops non-positive pollIntervalMs', () => {
    expect(parseAiderdeskConfig({ pollIntervalMs: 0 }).pollIntervalMs).toBeUndefined();
    expect(parseAiderdeskConfig({ pollIntervalMs: -100 }).pollIntervalMs).toBeUndefined();
  });

  it('parses valid requestTimeoutMs', () => {
    const result = parseAiderdeskConfig({ requestTimeoutMs: 60000 });
    expect(result.requestTimeoutMs).toBe(60000);
  });

  it('parses valid clearContextAfterRun boolean', () => {
    expect(parseAiderdeskConfig({ clearContextAfterRun: true }).clearContextAfterRun).toBe(true);
    expect(parseAiderdeskConfig({ clearContextAfterRun: false }).clearContextAfterRun).toBe(false);
  });

  it('drops non-string model silently', () => {
    const result = parseAiderdeskConfig({ model: 123 });
    expect(result.model).toBeUndefined();
  });

  it('drops non-boolean clearContextAfterRun silently', () => {
    const result = parseAiderdeskConfig({ clearContextAfterRun: 'yes' });
    expect(result.clearContextAfterRun).toBeUndefined();
  });

  it('never throws on garbage input', () => {
    expect(() => parseAiderdeskConfig(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() =>
      parseAiderdeskConfig(undefined as unknown as Record<string, unknown>)
    ).not.toThrow();
  });

  it('parses multiple valid fields together', () => {
    const result = parseAiderdeskConfig({
      model: 'ollama/qwen3-coder:30b',
      apiUrl: 'http://172.18.0.1:24337',
      mode: 'code',
      pollIntervalMs: 750,
      requestTimeoutMs: 120000,
      clearContextAfterRun: true,
    });
    expect(result).toEqual({
      model: 'ollama/qwen3-coder:30b',
      apiUrl: 'http://172.18.0.1:24337',
      mode: 'code',
      pollIntervalMs: 750,
      requestTimeoutMs: 120000,
      clearContextAfterRun: true,
    });
  });
});
