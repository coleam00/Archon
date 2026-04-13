import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  getRegisteredProviders,
  registerProvider,
  type ProviderRegistration,
} from '@archon/providers';
import { bootstrapServerProviderRegistry } from './provider-bootstrap';

function makeCommunityProvider(id: string): ProviderRegistration {
  return {
    id,
    displayName: `Mock ${id}`,
    factory: () => ({
      getType: () => id,
      getCapabilities: () => ({
        sessionResume: false,
        mcp: false,
        hooks: false,
        skills: false,
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
    }),
    capabilities: {
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: false,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    },
    isModelCompatible: () => true,
    builtIn: false,
  };
}

describe('bootstrapServerProviderRegistry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('registers built-in providers', () => {
    bootstrapServerProviderRegistry();
    const ids = getRegisteredProviders().map(provider => provider.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
  });

  test('preserves existing community providers', () => {
    registerProvider(makeCommunityProvider('custom'));
    bootstrapServerProviderRegistry();
    const ids = getRegisteredProviders().map(provider => provider.id);
    expect(ids).toContain('custom');
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
  });
});
