import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getAgentProvider,
  getProviderCapabilities,
  registerProvider,
  getRegistration,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  registerBuiltinProviders,
  registerCommunityProviders,
  clearRegistry,
} from './registry';
import {
  isCopilotModelCompatible,
  registerCopilotProvider,
} from './community/copilot/registration';
import { registerPiProvider } from './community/pi/registration';
import { UnknownProviderError } from './errors';
import type { ProviderRegistration, IAgentProvider, ProviderCapabilities } from './types';

/** Minimal mock provider for testing registration. */
function makeMockProvider(id: string): IAgentProvider {
  return {
    getType: () => id,
    getCapabilities: () => ({
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: false,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    }),
    async *sendQuery() {
      yield { type: 'result' as const };
    },
  };
}

function makeMockRegistration(
  id: string,
  overrides?: Partial<ProviderRegistration>
): ProviderRegistration {
  return {
    id,
    displayName: `Mock ${id}`,
    factory: () => makeMockProvider(id),
    capabilities: makeMockProvider(id).getCapabilities(),
    builtIn: false,
    ...overrides,
  };
}

describe('registry', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
  });

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

      expect(provider1).not.toBe(provider2);
    });

    test('providers expose getCapabilities', () => {
      const claude = getAgentProvider('claude');
      const codex = getAgentProvider('codex');

      expect(typeof claude.getCapabilities).toBe('function');
      expect(typeof codex.getCapabilities).toBe('function');

      const claudeCaps = claude.getCapabilities();
      const codexCaps = codex.getCapabilities();

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

  describe('registerProvider', () => {
    test('registers a new provider', () => {
      const entry = makeMockRegistration('my-llm');
      registerProvider(entry);

      expect(isRegisteredProvider('my-llm')).toBe(true);
      const provider = getAgentProvider('my-llm');
      expect(provider.getType()).toBe('my-llm');
    });

    test('throws on duplicate registration', () => {
      expect(() => registerProvider(makeMockRegistration('claude'))).toThrow(
        "Provider 'claude' is already registered"
      );
    });
  });

  describe('getRegistration', () => {
    test('returns full registration entry', () => {
      const reg = getRegistration('claude');
      expect(reg.id).toBe('claude');
      expect(reg.displayName).toBe('Claude (Anthropic)');
      expect(reg.builtIn).toBe(true);
      expect(typeof reg.factory).toBe('function');
    });

    test('throws for unknown provider', () => {
      expect(() => getRegistration('nope')).toThrow(UnknownProviderError);
    });
  });

  describe('getRegisteredProviders', () => {
    test('returns all registered providers', () => {
      const all = getRegisteredProviders();
      expect(all.length).toBe(2);
      const ids = all.map(r => r.id);
      expect(ids).toContain('claude');
      expect(ids).toContain('codex');
    });

    test('includes community providers after registration', () => {
      registerProvider(makeMockRegistration('my-llm'));
      const all = getRegisteredProviders();
      expect(all.length).toBe(3);
    });
  });

  describe('getProviderInfoList', () => {
    test('returns API-safe projection without factory', () => {
      const infos = getProviderInfoList();
      expect(infos.length).toBe(2);
      for (const info of infos) {
        expect(info).toHaveProperty('id');
        expect(info).toHaveProperty('displayName');
        expect(info).toHaveProperty('capabilities');
        expect(info).toHaveProperty('builtIn');
        expect(info).not.toHaveProperty('factory');
        expect(info).not.toHaveProperty('isModelCompatible');
      }
    });
  });

  describe('isRegisteredProvider', () => {
    test('returns true for registered providers', () => {
      expect(isRegisteredProvider('claude')).toBe(true);
      expect(isRegisteredProvider('codex')).toBe(true);
    });

    test('returns false for unknown providers', () => {
      expect(isRegisteredProvider('unknown')).toBe(false);
      expect(isRegisteredProvider('')).toBe(false);
    });
  });

  describe('registerBuiltinProviders', () => {
    test('is idempotent', () => {
      registerBuiltinProviders();
      registerBuiltinProviders();
      const all = getRegisteredProviders();
      expect(all.length).toBe(2);
    });
  });

  describe('clearRegistry', () => {
    test('empties the registry', () => {
      clearRegistry();
      expect(getRegisteredProviders()).toEqual([]);
      expect(isRegisteredProvider('claude')).toBe(false);
    });
  });

  describe('registerCommunityProviders (aggregator)', () => {
    test('registers all bundled community providers', () => {
      registerCommunityProviders();
      // Bundled community providers should appear here automatically.
      expect(isRegisteredProvider('copilot')).toBe(true);
      expect(isRegisteredProvider('pi')).toBe(true);
    });

    test('is idempotent', () => {
      registerCommunityProviders();
      expect(() => registerCommunityProviders()).not.toThrow();
      const copilotCount = getRegisteredProviders().filter(p => p.id === 'copilot').length;
      const piCount = getRegisteredProviders().filter(p => p.id === 'pi').length;
      expect(copilotCount).toBe(1);
      expect(piCount).toBe(1);
    });
  });

  describe('registerCopilotProvider (community provider)', () => {
    test('registers copilot with builtIn: false', () => {
      registerCopilotProvider();
      const reg = getRegistration('copilot');
      expect(reg.id).toBe('copilot');
      expect(reg.displayName).toBe('GitHub Copilot (community)');
      expect(reg.builtIn).toBe(false);
    });

    test('is idempotent', () => {
      registerCopilotProvider();
      expect(() => registerCopilotProvider()).not.toThrow();
      const entries = getRegisteredProviders().filter(p => p.id === 'copilot');
      expect(entries).toHaveLength(1);
    });

    test('declares conservative capabilities', () => {
      registerCopilotProvider();
      const caps = getProviderCapabilities('copilot');
      expect(caps.sessionResume).toBe(true);
      expect(caps.envInjection).toBe(true);
      expect(caps.effortControl).toBe(true);
      expect(caps.thinkingControl).toBe(true);
      expect(caps.mcp).toBe(true);
      expect(caps.hooks).toBe(false);
      expect(caps.skills).toBe(true);
      expect(caps.toolRestrictions).toBe(true);
      expect(caps.structuredOutput).toBe(true);
      expect(caps.agents).toBe(true);
      expect(caps.fallbackModel).toBe(false);
      expect(caps.sandbox).toBe(false);
    });

    test('isModelCompatible accepts non-empty explicit model strings', () => {
      registerCopilotProvider();
      const reg = getRegistration('copilot');
      expect(reg.isModelCompatible('gpt-5')).toBe(true);
      expect(reg.isModelCompatible('claude-sonnet-4.5')).toBe(true);
      expect(reg.isModelCompatible('  gpt-5-mini  ')).toBe(true);
      expect(reg.isModelCompatible('')).toBe(false);
      expect(reg.isModelCompatible('inherit')).toBe(false);
      expect(isCopilotModelCompatible('gpt-5')).toBe(true);
    });

    test('appears in getProviderInfoList with builtIn: false', () => {
      registerCopilotProvider();
      const info = getProviderInfoList().find(p => p.id === 'copilot');
      expect(info).toBeDefined();
      expect(info?.builtIn).toBe(false);
    });

    test('does not collide with built-ins', () => {
      registerCopilotProvider();
      const ids = getRegisteredProviders()
        .map(p => p.id)
        .sort();
      expect(ids).toEqual(['claude', 'codex', 'copilot']);
    });
  });

  describe('registerPiProvider (community provider)', () => {
    test('registers pi with builtIn: false', () => {
      registerPiProvider();
      const reg = getRegistration('pi');
      expect(reg.id).toBe('pi');
      expect(reg.displayName).toBe('Pi (community)');
      expect(reg.builtIn).toBe(false);
    });

    test('is idempotent', () => {
      registerPiProvider();
      expect(() => registerPiProvider()).not.toThrow();
      const piEntries = getRegisteredProviders().filter(p => p.id === 'pi');
      expect(piEntries).toHaveLength(1);
    });

    test('declares v2 capabilities (thinking, effort, tools, skills, sessionResume, envInjection, structuredOutput supported)', () => {
      registerPiProvider();
      const caps = getProviderCapabilities('pi');
      // Flipped true in v2
      expect(caps.thinkingControl).toBe(true);
      expect(caps.effortControl).toBe(true);
      expect(caps.toolRestrictions).toBe(true);
      expect(caps.skills).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.envInjection).toBe(true);
      // Best-effort structured output via prompt engineering + post-parse —
      // not SDK-enforced like Claude/Codex, but wired up and tested.
      expect(caps.structuredOutput).toBe(true);
      // Still false (out of v2 scope)
      expect(caps.mcp).toBe(false);
      expect(caps.hooks).toBe(false);
      expect(caps.costControl).toBe(false);
      expect(caps.fallbackModel).toBe(false);
      expect(caps.sandbox).toBe(false);
    });

    test('appears in getProviderInfoList with builtIn: false', () => {
      registerPiProvider();
      const info = getProviderInfoList().find(p => p.id === 'pi');
      expect(info).toBeDefined();
      expect(info?.builtIn).toBe(false);
    });

    test('does not collide with built-ins', () => {
      // beforeEach already called registerBuiltinProviders + clearRegistry reset
      registerPiProvider();
      const ids = getRegisteredProviders()
        .map(p => p.id)
        .sort();
      expect(ids).toEqual(['claude', 'codex', 'pi']);
    });
  });
});
