import { expect, mock, test } from 'bun:test';

let sdkLoaded = false;
mock.module('@github/copilot/copilot-sdk', () => {
  sdkLoaded = true;
  return {};
});

test('registering and instantiating the Copilot provider does not eagerly load the SDK', async () => {
  const { clearRegistry, getAgentProvider, registerCommunityProviders } =
    await import('../../registry');
  clearRegistry();
  registerCommunityProviders();
  const provider = getAgentProvider('copilot');
  expect(provider.getType()).toBe('copilot');
  expect(provider.getCapabilities()).toBeDefined();
  expect(sdkLoaded).toBe(false);
});
