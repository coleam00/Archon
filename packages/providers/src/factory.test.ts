import { describe, test, expect } from 'bun:test';
import { getAgentProvider, getProviderCapabilities } from './factory';
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

    test('returns PiProvider for pi type', () => {
      const provider = getAgentProvider('pi');

      expect(provider).toBeDefined();
      expect(provider.getType()).toBe('pi');
      expect(typeof provider.sendQuery).toBe('function');
    });

    test('throws UnknownProviderError for unknown type', () => {
      expect(() => getAgentProvider('unknown')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('unknown')).toThrow(
        "Unknown provider: 'unknown'. Available: claude, codex, pi"
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

  describe('getProviderCapabilities', () => {
    test('returns Claude capabilities without instantiation', () => {
      const caps = getProviderCapabilities('claude');
      expect(caps.mcp).toBe(true);
      expect(caps.hooks).toBe(true);
      expect(caps.envInjection).toBe(true);
    });

    test('returns Codex capabilities without instantiation', () => {
      const caps = getProviderCapabilities('codex');
      expect(caps.mcp).toBe(false);
      expect(caps.hooks).toBe(false);
      expect(caps.envInjection).toBe(true);
    });

    test('returns Pi capabilities without instantiation', () => {
      const caps = getProviderCapabilities('pi');
      expect(caps.mcp).toBe(false);
      expect(caps.hooks).toBe(false);
      expect(caps.envInjection).toBe(false);
      expect(caps.sessionResume).toBe(false);
    });

    test('matches runtime getCapabilities for Claude', () => {
      const staticCaps = getProviderCapabilities('claude');
      const runtimeCaps = getAgentProvider('claude').getCapabilities();
      expect(staticCaps).toEqual(runtimeCaps);
    });

    test('matches runtime getCapabilities for Codex', () => {
      const staticCaps = getProviderCapabilities('codex');
      const runtimeCaps = getAgentProvider('codex').getCapabilities();
      expect(staticCaps).toEqual(runtimeCaps);
    });

    test('matches runtime getCapabilities for Pi', () => {
      const staticCaps = getProviderCapabilities('pi');
      const runtimeCaps = getAgentProvider('pi').getCapabilities();
      expect(staticCaps).toEqual(runtimeCaps);
    });

    test('throws UnknownProviderError for unknown type', () => {
      expect(() => getProviderCapabilities('unknown')).toThrow(UnknownProviderError);
    });

    test('throws UnknownProviderError for empty string', () => {
      expect(() => getProviderCapabilities('')).toThrow(UnknownProviderError);
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getProviderCapabilities('Claude')).toThrow(UnknownProviderError);
    });
  });
});
