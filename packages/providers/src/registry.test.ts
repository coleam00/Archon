import {
  registerBuiltinProviders,
  registerCommunityProviders,
  registerInProcessProviders,
} from './in-process';
import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import * as paths from '@archon/paths';
import {
  providerRegistry,
  getAgentProvider,
  setDeprecationReporter,
  getProviderCapabilities,
  registerProvider,
  getRegistration,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  clearRegistry,
} from './registry';
import { registerPiProvider } from './community/pi/registration';
import { registerCopilotProvider } from './community/copilot/registration';
import { registerOpencodeProvider } from './community/opencode/registration';
import { deprecatedChatProviderNotice, deprecatedForRemovalNotice } from './community/deprecation';
import type { ProviderRegistration, IAgentProvider } from './types';
import { EFFORT_LADDER, UnknownProviderError } from '@archon/provider-contract';

// The registry creates its logger on first use and keeps it; hand it one this file can
// observe. Module scope, so the spy is in place before any test makes the registry log.
const registryLog = paths.createLogger('provider.registry');
const realCreateLogger = paths.createLogger;
spyOn(paths, 'createLogger').mockImplementation(module =>
  module === 'provider.registry' ? registryLog : realCreateLogger(module)
);

/** Minimal mock provider for testing registration. */
function makeMockProvider(id: string): IAgentProvider {
  return {
    getType: () => id,
    checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
    getCapabilities: () => ({
      backgroundWork: 'unobserved' as const,
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      plugins: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false,
      requiresAllPropertiesRequired: false,
      envInjection: false,
      costControl: false,
      costReporting: false,
      effortControl: false,
      fallbackModel: false,
      sandbox: false,
      nativeTools: false,
      containerExec: false,
      settingSources: false,
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
    credentials: { kind: 'static', specs: [], vendorFor: () => undefined },
    ...overrides,
    parseConfig: overrides?.parseConfig ?? (raw => raw),
  };
}

describe('registry', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
  });

  test('read-only registry reflects registration order without instantiating providers', () => {
    const factory = () => {
      throw new Error('metadata reads must not instantiate');
    };
    expect(providerRegistry.get('absent')).toBeUndefined();
    const entry = makeMockRegistration('custom', { factory });
    registerProvider(entry);
    expect(providerRegistry.get('custom')).toMatchObject({
      ...entry,
      factory: expect.any(Function),
    });
    expect(providerRegistry.list().map(provider => provider.id)).toEqual([
      'claude',
      'codex',
      'custom',
    ]);
    clearRegistry();
    expect(providerRegistry.list()).toEqual([]);
  });

  test('only one provider can own unprefixed model refs', () => {
    registerProvider(makeMockRegistration('first', { ownsUnprefixedModelRefs: true }));
    expect(() =>
      registerProvider(makeMockRegistration('second', { ownsUnprefixedModelRefs: true }))
    ).toThrow("Provider 'first' already owns unprefixed model refs");
    expect(providerRegistry.get('second')).toBeUndefined();
    expect(() => registerPiProvider()).toThrow(
      "Provider 'first' already owns unprefixed model refs"
    );
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

    test('logs a deprecated provider once per process, however often it is resolved', () => {
      registerProvider(makeMockRegistration('old', { deprecationNotice: 'old is deprecated' }));
      const warn = spyOn(registryLog, 'warn').mockImplementation(() => undefined);
      try {
        getAgentProvider('old');
        getAgentProvider('old');
        getAgentProvider('claude');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          { provider: 'old', notice: 'old is deprecated' },
          'provider.deprecated'
        );
      } finally {
        warn.mockRestore();
      }
    });

    test("a host's deprecation reporter replaces the log line, once per process", () => {
      registerProvider(makeMockRegistration('old', { deprecationNotice: 'old is deprecated' }));
      const report = mock((_provider: string, _notice: string) => undefined);
      const warn = spyOn(registryLog, 'warn').mockImplementation(() => undefined);
      try {
        setDeprecationReporter(report);
        getAgentProvider('old');
        getAgentProvider('old');
        expect(report.mock.calls).toEqual([['old', 'old is deprecated']]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    test('providers expose getCapabilities', () => {
      const claude = getAgentProvider('claude');
      const codex = getAgentProvider('codex');

      expect(typeof claude.getCapabilities).toBe('function');
      expect(typeof codex.getCapabilities).toBe('function');

      const claudeCaps = claude.getCapabilities();
      const codexCaps = codex.getCapabilities();

      expect(claudeCaps.mcp).toBe(true);
      expect(codexCaps.mcp).toBe(true);
      expect(claudeCaps.hooks).toBe(true);
      expect(codexCaps.hooks).toBe(false);
    });
  });

  describe('getProviderCapabilities', () => {
    test('returns Claude capabilities without instantiation', () => {
      const caps = getProviderCapabilities('claude');
      expect(caps.sessionFork).toBe(true);
      expect(caps.mcp).toBe(true);
      expect(caps.hooks).toBe(true);
      expect(caps.envInjection).toBe(true);
    });

    test('returns Codex capabilities without instantiation', () => {
      const caps = getProviderCapabilities('codex');
      expect(caps.sessionFork).toBe(true);
      expect(caps.mcp).toBe(true);
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
    test('rejects a duplicate without replacing the existing registration', () => {
      const entry = makeMockRegistration('custom');
      registerProvider(entry);
      const registered = providerRegistry.get('custom');
      const before = providerRegistry.list();
      expect(() => registerProvider(makeMockRegistration('custom'))).toThrow(
        "Provider 'custom' is already registered"
      );
      expect(providerRegistry.get('custom')).toBe(registered);
      expect(providerRegistry.list()).toEqual(before);
    });

    test('rejects invalid fork capabilities without inserting the registration', () => {
      const entry = makeMockRegistration('invalid-fork');
      entry.capabilities.sessionFork = true;
      const before = providerRegistry.list();
      expect(() => registerProvider(entry)).toThrow(
        "Provider 'invalid-fork' cannot advertise sessionFork without sessionResume"
      );
      expect(providerRegistry.get('invalid-fork')).toBeUndefined();
      expect(providerRegistry.list()).toEqual(before);
    });

    test('registered factories derive instance capabilities from the descriptor', async () => {
      const nativeCapabilities = mock(() => ({
        ...makeMockProvider('custom').getCapabilities(),
        backgroundWork: 'reported' as const,
      }));
      const factory = mock(() => ({
        ...makeMockProvider('custom'),
        getCapabilities: nativeCapabilities,
      }));
      const entry = makeMockRegistration('custom', {
        factory,
        capabilities: { ...makeMockProvider('custom').getCapabilities(), backgroundWork: 'none' },
      });
      nativeCapabilities.mockClear();
      registerProvider(entry);

      expect(getProviderCapabilities('custom')).toBe(entry.capabilities);
      expect(providerRegistry.get('custom')?.capabilities).toBe(entry.capabilities);
      expect(factory).not.toHaveBeenCalled();

      for (const provider of [
        getAgentProvider('custom'),
        getRegistration('custom').factory(),
        ...getRegisteredProviders()
          .filter(provider => provider.id === 'custom')
          .map(provider => provider.factory()),
      ]) {
        expect(provider.getCapabilities()).toBe(entry.capabilities);
        expect(provider.getType()).toBe('custom');
        expect(await Array.fromAsync(provider.sendQuery('prompt', '/tmp'))).toEqual([
          { type: 'result' },
        ]);
      }
      expect(factory).toHaveBeenCalledTimes(3);
      expect(new Set(factory.mock.results.map(result => result.value)).size).toBe(3);
      expect(nativeCapabilities).not.toHaveBeenCalled();
    });

    test.each(['frozen', 'sealed', 'readonly', 'getter-only'] as const)(
      'adapts a %s provider without changing it or its method receivers',
      async shape => {
        const nativeCaps = makeMockProvider('custom').getCapabilities();
        class NativeProvider implements IAgentProvider {
          #id = 'custom';
          getType() {
            return this.#id;
          }
          getCapabilities() {
            return nativeCaps;
          }
          async *sendQuery(...args: Parameters<IAgentProvider['sendQuery']>) {
            expect(args).toEqual(['prompt', '/tmp', 'resume', { model: 'model' }]);
            yield { type: 'result' as const, sessionId: this.#id };
          }
          async checkCredential() {
            expect(this.#id).toBe('custom');
            return { state: 'not_checked' as const, source: 'native' as const };
          }
          async resolveCredentialModel() {
            return this.#id;
          }
          async diagnose() {
            return {
              checks: [{ id: this.#id, label: 'native', status: 'ok' as const, message: '' }],
            };
          }
          async listModels() {
            return { models: [{ id: this.#id }] };
          }
        }
        const native = new NativeProvider();
        if (shape === 'frozen') Object.freeze(native);
        if (shape === 'sealed') Object.seal(native);
        if (shape === 'readonly') {
          Object.defineProperty(native, 'getCapabilities', {
            value: native.getCapabilities,
            writable: false,
          });
        }
        if (shape === 'getter-only') {
          Object.defineProperty(native, 'getCapabilities', {
            get: () => NativeProvider.prototype.getCapabilities,
          });
        }
        const before = Object.getOwnPropertyDescriptors(native);
        const entry = makeMockRegistration('custom', {
          factory: () => native,
          capabilities: { ...nativeCaps, backgroundWork: 'none' },
        });
        registerProvider(entry);
        const signal = new AbortController().signal;
        for (const provider of [
          getAgentProvider('custom'),
          getRegistration('custom').factory(),
          ...getRegisteredProviders()
            .filter(entry => entry.id === 'custom')
            .map(entry => entry.factory()),
        ]) {
          expect(provider.getCapabilities()).toBe(entry.capabilities);
          expect(provider.getType()).toBe('custom');
          expect(
            await Array.fromAsync(
              provider.sendQuery('prompt', '/tmp', 'resume', { model: 'model' })
            )
          ).toEqual([{ type: 'result', sessionId: 'custom' }]);
          expect(await provider.checkCredential({ env: {}, signal })).toEqual({
            state: 'not_checked',
            source: 'native',
          });
          expect(await provider.resolveCredentialModel?.({ cwd: '/tmp' })).toBe('custom');
          expect(await provider.diagnose?.({ signal })).toEqual({
            checks: [{ id: 'custom', label: 'native', status: 'ok', message: '' }],
          });
          expect(await provider.listModels?.({ signal })).toEqual({ models: [{ id: 'custom' }] });
        }
        expect(Object.getOwnPropertyDescriptors(native)).toEqual(before);
        expect(native.getCapabilities()).toBe(nativeCaps);
      }
    );

    test('shared factory results retain a separate capability view for each registration', () => {
      const native = makeMockProvider('shared');
      const nativeCaps = native.getCapabilities();
      native.getCapabilities = () => nativeCaps;
      const first = makeMockRegistration('first', {
        factory: () => native,
        capabilities: { ...nativeCaps, backgroundWork: 'none' },
      });
      const second = makeMockRegistration('second', {
        factory: () => native,
        capabilities: { ...nativeCaps, backgroundWork: 'reported' },
      });
      registerProvider(first);
      registerProvider(second);
      const firstProvider = getAgentProvider('first');
      const secondProvider = getAgentProvider('second');
      expect(firstProvider.getCapabilities()).toBe(first.capabilities);
      expect(secondProvider.getCapabilities()).toBe(second.capabilities);
      expect(firstProvider.getType()).toBe('shared');
      expect(secondProvider.getType()).toBe('shared');
      expect(native.getCapabilities()).toBe(nativeCaps);
    });

    test('registers a new provider', () => {
      const entry = makeMockRegistration('my-llm');
      registerProvider(entry);

      expect(isRegisteredProvider('my-llm')).toBe(true);
      const provider = getAgentProvider('my-llm');
      expect(provider.getType()).toBe('my-llm');
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
      expect(infos.find(info => info.id === 'codex')?.effortLevels).toBe(EFFORT_LADDER);
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
      expect(isRegisteredProvider('opencode')).toBe(true);
      expect(isRegisteredProvider('pi')).toBe(true);
      expect(isRegisteredProvider('copilot')).toBe(true);
    });

    test('only OpenCode and Copilot are deprecated', () => {
      registerCommunityProviders();
      const deprecated = getRegisteredProviders()
        .filter(p => p.deprecationNotice)
        .map(p => p.id)
        .sort();
      expect(deprecated).toEqual(['copilot', 'opencode']);
    });

    test('deprecated providers announce removal in the next minor release', () => {
      registerCommunityProviders();
      expect(deprecatedForRemovalNotice('Copilot')).toBe(
        'Copilot is deprecated and will be removed in the next minor release: no Archon ' +
          'maintainer owns it. It keeps working until then. If you need it, build your own ' +
          'plugin: https://archon.diy/guides/publishing-plugins/'
      );
      expect(getRegistration('copilot').deprecationNotice).toBe(
        deprecatedChatProviderNotice('Copilot')
      );
      expect(getRegistration('opencode').deprecationNotice).toBe(
        deprecatedChatProviderNotice('OpenCode')
      );
      for (const provider of ['copilot', 'opencode']) {
        const notice = getRegistration(provider).deprecationNotice;
        expect(notice).toContain('headless');
        expect(notice).toContain('CLI identity');
        expect(notice).toContain('do not deliver progress or results');
      }
    });

    test('is idempotent', () => {
      registerCommunityProviders();
      expect(() => registerCommunityProviders()).not.toThrow();
      const opencodeCount = getRegisteredProviders().filter(p => p.id === 'opencode').length;
      const piCount = getRegisteredProviders().filter(p => p.id === 'pi').length;
      const copilotCount = getRegisteredProviders().filter(p => p.id === 'copilot').length;
      expect(opencodeCount).toBe(1);
      expect(piCount).toBe(1);
      expect(copilotCount).toBe(1);
    });
  });

  describe('registerPiProvider (community provider)', () => {
    test('registers pi with builtIn: true', () => {
      registerPiProvider();
      const reg = getRegistration('pi');
      expect(reg.id).toBe('pi');
      expect(reg.displayName).toBe('Pi');
      expect(reg.builtIn).toBe(true);
    });

    test('is idempotent', () => {
      registerPiProvider();
      expect(() => registerPiProvider()).not.toThrow();
      const piEntries = getRegisteredProviders().filter(p => p.id === 'pi');
      expect(piEntries).toHaveLength(1);
    });

    test('declares v2 capabilities (effort, tools, skills, sessionResume, envInjection, structuredOutput, costReporting supported)', () => {
      registerPiProvider();
      const caps = getProviderCapabilities('pi');
      // Flipped true in v2
      expect(caps.effortControl).toBe(true);
      expect(caps.toolRestrictions).toBe(true);
      expect(caps.skills).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.sessionFork).toBe(true);
      expect(caps.envInjection).toBe(true);
      // Best-effort structured output via prompt engineering + post-parse —
      // not SDK-enforced like Claude/Codex, but wired up and tested.
      expect(caps.structuredOutput).toBe('best-effort');
      // Pi prices every turn yet cannot cap one — the two cost axes are independent.
      expect(caps.costReporting).toBe(true);
      // Still false (out of v2 scope)
      expect(caps.mcp).toBe(false);
      expect(caps.hooks).toBe(false);
      expect(caps.costControl).toBe(false);
      expect(caps.fallbackModel).toBe(false);
      expect(caps.sandbox).toBe(false);
    });

    test('appears in getProviderInfoList with builtIn: true', () => {
      registerPiProvider();
      const info = getProviderInfoList().find(p => p.id === 'pi');
      expect(info).toBeDefined();
      expect(info?.builtIn).toBe(true);
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

  describe('registerOpencodeProvider (community provider)', () => {
    test('registers opencode with builtIn: false', () => {
      registerOpencodeProvider();
      const reg = getRegistration('opencode');
      expect(reg.id).toBe('opencode');
      expect(reg.displayName).toBe('OpenCode (community)');
      expect(reg.builtIn).toBe(false);
    });

    test('is idempotent', () => {
      registerOpencodeProvider();
      expect(() => registerOpencodeProvider()).not.toThrow();
      const opencodeEntries = getRegisteredProviders().filter(p => p.id === 'opencode');
      expect(opencodeEntries).toHaveLength(1);
    });

    test('declares capabilities (sessionResume, structuredOutput, agents, toolRestrictions, costReporting supported; untranslated node fields and env injection stay off)', () => {
      registerOpencodeProvider();
      const caps = getProviderCapabilities('opencode');
      expect(caps.sessionResume).toBe(true);
      expect(caps.mcp).toBe(false);
      expect(caps.structuredOutput).toBe('enforced');
      expect(caps.envInjection).toBe(false);
      expect(caps.hooks).toBe(false);
      expect(caps.skills).toBe(false);
      expect(caps.agents).toBe(true);
      expect(caps.toolRestrictions).toBe(true);
      expect(caps.effortControl).toBe(false);
      expect(caps.costControl).toBe(false);
      expect(caps.costReporting).toBe(true);
      expect(caps.fallbackModel).toBe(false);
      expect(caps.sandbox).toBe(false);
    });

    test('appears in getProviderInfoList with builtIn: false', () => {
      registerOpencodeProvider();
      const info = getProviderInfoList().find(p => p.id === 'opencode');
      expect(info).toBeDefined();
      expect(info?.builtIn).toBe(false);
    });

    test('does not collide with built-ins or other community providers', () => {
      registerOpencodeProvider();
      registerPiProvider();
      const ids = getRegisteredProviders()
        .map(p => p.id)
        .sort();
      expect(ids).toEqual(['claude', 'codex', 'opencode', 'pi']);
    });
  });

  describe('registerCopilotProvider (community provider)', () => {
    test('registers copilot with builtIn: false', () => {
      registerCopilotProvider();
      const reg = getRegistration('copilot');
      expect(reg.id).toBe('copilot');
      expect(reg.displayName).toBe('Copilot (GitHub)');
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
      expect(caps.mcp).toBe(true);
      expect(caps.hooks).toBe(false);
      expect(caps.skills).toBe(true);
      expect(caps.toolRestrictions).toBe(true);
      expect(caps.structuredOutput).toBe('best-effort');
      expect(caps.agents).toBe(true);
      expect(caps.costReporting).toBe(false);
      expect(caps.fallbackModel).toBe(false);
      expect(caps.sandbox).toBe(false);
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
});

describe('credential vendor mapping', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
    registerCommunityProviders();
  });
  test('single-vendor providers resolve every model from their own spec', () => {
    for (const [id, vendor] of [
      ['claude', 'anthropic'],
      ['codex', 'openai'],
      ['copilot', 'github-copilot'],
    ]) {
      const catalog = getRegistration(id).credentials;
      expect(catalog.vendorFor(undefined)).toBe(vendor);
      expect(catalog.vendorFor('any-model')).toBe(vendor);
      if (catalog.kind === 'static')
        expect(catalog.specs.map(spec => spec.vendor)).toEqual([vendor]);
    }
  });
  test('Pi maps only models whose vendor is in its catalog', () => {
    const { vendorFor } = getRegistration('pi').credentials;
    expect(vendorFor('anthropic/claude-sonnet-4-6')).toBe('anthropic');
    expect(vendorFor('github-copilot/gpt-5.6')).toBe('github-copilot');
    expect(vendorFor('google/gemini-3-pro')).toBe('google');
    expect(vendorFor('copilot/gpt-5.6')).toBe('github-copilot');
    expect(vendorFor('ollama/local')).toBeUndefined();
    expect(vendorFor('broken')).toBeUndefined();
    expect(vendorFor(undefined)).toBeUndefined();
  });
  test('OpenCode has no stored-credential mapping', () => {
    expect(getRegistration('opencode').credentials.vendorFor('anthropic/claude')).toBeUndefined();
  });
});

test('in-process registration includes maintained and transition providers and agrees with their factories', () => {
  clearRegistry();
  registerInProcessProviders();
  registerInProcessProviders();
  expect(
    getRegisteredProviders()
      .map(provider => provider.id)
      .sort()
  ).toEqual(['claude', 'codex', 'copilot', 'opencode', 'pi']);
  for (const registration of getRegisteredProviders()) {
    const provider = registration.factory();
    expect(provider.getType()).toBe(registration.id);
    expect(provider.getCapabilities()).toEqual(registration.capabilities);
  }
  expect(
    getRegisteredProviders()
      .filter(provider => provider.builtIn)
      .map(provider => provider.id)
  ).toEqual(['claude', 'codex', 'pi']);
});
