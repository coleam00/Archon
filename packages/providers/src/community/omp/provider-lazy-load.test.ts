/**
 * Regression: OMP SDK must not load at module-import time (compiled-binary safety).
 */
import { expect, mock, test } from 'bun:test';

let ompCodingAgentLoaded = false;

mock.module('@oh-my-pi/pi-coding-agent', () => {
  ompCodingAgentLoaded = true;
  return {};
});

test('registering and instantiating the OMP provider does not eagerly load the OMP SDK', async () => {
  const { clearRegistry, getAgentProvider, registerCommunityProviders } =
    await import('../../registry');

  clearRegistry();
  registerCommunityProviders();

  const provider = getAgentProvider('omp');
  expect(provider.getType()).toBe('omp');
  expect(provider.getCapabilities()).toBeDefined();
  expect(ompCodingAgentLoaded).toBe(false);
});
