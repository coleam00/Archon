import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { HermesProvider } from './provider';
import { HERMES_CAPABILITIES } from './capabilities';

describe('HermesProvider', () => {
  let provider: HermesProvider;

  beforeEach(() => {
    provider = new HermesProvider();
  });

  afterEach(() => {
    // cleanup if needed
  });

  it('getType returns hermes', () => {
    expect(provider.getType()).toBe('hermes');
  });

  it('getCapabilities returns HERMES_CAPABILITIES', () => {
    expect(provider.getCapabilities()).toBe(HERMES_CAPABILITIES);
  });

  it('capabilities has expected conservative flags', () => {
    const caps = provider.getCapabilities();
    expect(caps.skills).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.envInjection).toBe(true);
    expect(caps.sessionResume).toBe(false);
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
    expect(caps.agents).toBe(false);
  });
});
