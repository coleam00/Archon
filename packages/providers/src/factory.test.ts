import { describe, test, expect } from 'bun:test';
import { getAgentProvider } from './factory';
import { UnknownProviderError } from './errors';

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

    test('throws UnknownProviderError for unknown type', () => {
      expect(() => getAgentProvider('unknown')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('unknown')).toThrow(
        "Unknown provider: 'unknown'. Available: claude, codex"
      );
    });

    test('throws UnknownProviderError for empty string', () => {
      expect(() => getAgentProvider('')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('')).toThrow("Unknown provider: ''");
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getAgentProvider('Claude')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('Claude')).toThrow("Unknown provider: 'Claude'");
    });

    test('each call returns new instance', () => {
      const provider1 = getAgentProvider('claude');
      const provider2 = getAgentProvider('claude');

      // Each call should return a new instance
      expect(provider1).not.toBe(provider2);
    });

    test('providers expose getCapabilities', () => {
      const claude = getAgentProvider('claude');
      const codex = getAgentProvider('codex');

      expect(typeof claude.getCapabilities).toBe('function');
      expect(typeof codex.getCapabilities).toBe('function');

      const claudeCaps = claude.getCapabilities();
      const codexCaps = codex.getCapabilities();

      // Claude supports more features than Codex
      expect(claudeCaps.mcp).toBe(true);
      expect(codexCaps.mcp).toBe(false);
      expect(claudeCaps.hooks).toBe(true);
      expect(codexCaps.hooks).toBe(false);
    });
  });
});
