import { describe, test, expect } from 'bun:test';
import { getAgentProvider } from './factory';

describe('factory', () => {
  describe('getAgentProvider', () => {
    test('returns ClaudeProvider for claude type', () => {
      const provider = getAgentProvider('claude');

      expect(provider).toBeDefined();
      expect(provider.getType()).toBe('claude');
      expect(typeof provider.sendQuery).toBe('function');
    });

    test('returns CodexProvider for codex type', () => {
      const provider = getAgentProvider('codex');

      expect(provider).toBeDefined();
      expect(provider.getType()).toBe('codex');
      expect(typeof provider.sendQuery).toBe('function');
    });

    test('throws error for unknown type', () => {
      expect(() => getAgentProvider('unknown')).toThrow(
        "Unknown provider type: unknown. Supported types: 'claude', 'codex'"
      );
    });

    test('throws error for empty string', () => {
      expect(() => getAgentProvider('')).toThrow(
        "Unknown provider type: . Supported types: 'claude', 'codex'"
      );
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getAgentProvider('Claude')).toThrow(
        "Unknown provider type: Claude. Supported types: 'claude', 'codex'"
      );
    });

    test('each call returns new instance', () => {
      const provider1 = getAgentProvider('claude');
      const provider2 = getAgentProvider('claude');

      // Each call should return a new instance
      expect(provider1).not.toBe(provider2);
    });
  });
});
