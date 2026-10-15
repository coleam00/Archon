import { describe, expect, test } from 'bun:test';
import {
  assertProviderRegistrationAllowed,
  consumesStoredCredential,
  type ProviderCredentialCatalog,
  type ProviderRegistration,
} from './index';

function registration(
  id: string,
  overrides: Partial<ProviderRegistration> = {}
): ProviderRegistration {
  return {
    id,
    displayName: id,
    factory: () => {
      throw new Error('registration validation must not instantiate providers');
    },
    capabilities: {
      backgroundWork: 'unobserved',
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
    },
    builtIn: false,
    credentials: { kind: 'static', specs: [], vendorFor: () => undefined },
    parseConfig: raw => raw,
    ...overrides,
  };
}

describe('assertProviderRegistrationAllowed', () => {
  test('accepts distinct providers without instantiating or mutating them', () => {
    const first = registration('first');
    const existing = [first];
    const entry = registration('second');
    expect(() => assertProviderRegistrationAllowed(entry, existing)).not.toThrow();
    expect(existing).toEqual([first]);
  });

  test('rejects duplicate ids from an iterable', () => {
    const entry = registration('custom');
    const existing = new Map([[entry.id, entry]]);
    expect(() => assertProviderRegistrationAllowed(entry, existing.values())).toThrow(
      "Provider 'custom' is already registered"
    );
  });

  test('only one provider can own unprefixed model refs', () => {
    const owner = registration('first', { ownsUnprefixedModelRefs: true });
    const entry = registration('second', { ownsUnprefixedModelRefs: true });
    expect(() => assertProviderRegistrationAllowed(entry, [])).not.toThrow();
    expect(() => assertProviderRegistrationAllowed(entry, [owner])).toThrow(
      "Provider 'first' already owns unprefixed model refs"
    );
    expect(() => assertProviderRegistrationAllowed(registration('other'), [owner])).not.toThrow();
  });

  test('rejects session fork support without session resume support', () => {
    const entry = registration('invalid-fork');
    entry.capabilities.sessionFork = true;
    expect(() => assertProviderRegistrationAllowed(entry, [])).toThrow(
      "Provider 'invalid-fork' cannot advertise sessionFork without sessionResume"
    );
    entry.capabilities.sessionResume = true;
    expect(() => assertProviderRegistrationAllowed(entry, [])).not.toThrow();
  });
});

const catalog = (kinds: ['api_key'] | ['api_key', 'subscription']): ProviderCredentialCatalog => ({
  kind: 'static',
  specs: [{ vendor: 'anthropic', displayName: 'Anthropic', kinds }],
  vendorFor: () => 'anthropic',
});

describe('consumesStoredCredential', () => {
  test('a stored OAuth grant needs the subscription kind; a stored key needs api_key', () => {
    expect(consumesStoredCredential(catalog(['api_key']), 'anthropic', 'oauth')).toBe(false);
    expect(consumesStoredCredential(catalog(['api_key']), 'anthropic', 'api_key')).toBe(true);
    expect(
      consumesStoredCredential(catalog(['api_key', 'subscription']), 'anthropic', 'oauth')
    ).toBe(true);
  });

  test('an undeclared vendor or a dynamic catalog consumes nothing stored', () => {
    expect(consumesStoredCredential(catalog(['api_key']), 'openai', 'api_key')).toBe(false);
    expect(consumesStoredCredential({ kind: 'dynamic' }, 'anthropic', 'api_key')).toBe(false);
  });
});
