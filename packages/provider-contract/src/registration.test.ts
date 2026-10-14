import { describe, expect, test } from 'bun:test';
import { consumesStoredCredential, type ProviderCredentialCatalog } from './registration';

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
