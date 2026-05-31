import { expect, mock, test } from 'bun:test';

let cursorSdkLoaded = false;

mock.module('@cursor/sdk', () => {
  cursorSdkLoaded = true;
  return {};
});

test('registering and instantiating the Cursor provider does not eagerly load the SDK', async () => {
  const { clearRegistry, getAgentProvider, registerCommunityProviders } =
    await import('../../registry');

  clearRegistry();
  registerCommunityProviders();

  const provider = getAgentProvider('cursor');
  expect(provider.getType()).toBe('cursor');
  expect(provider.getCapabilities()).toBeDefined();
  expect(cursorSdkLoaded).toBe(false);
});
