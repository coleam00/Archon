/**
 * Regression test: @github/copilot-sdk must not load at module-import time.
 *
 * The SDK spawns the Copilot CLI subprocess from `new CopilotClient()`, and
 * its module graph may evolve in ways that add filesystem reads at import.
 * Inside a compiled Archon binary, eager SDK resolution during
 * `registerCommunityProviders()` would crash bootstrap before any command
 * runs. We defend by doing all SDK value imports inside `sendQuery` /
 * `getCopilotClient` via dynamic `await import(...)`.
 *
 * Detection: replace the SDK with a `mock.module` factory that flips a
 * boolean the first time it resolves. Walk the same registration path the
 * CLI and server take and assert the flag never tipped.
 *
 * Runs in its own `bun test` invocation because Bun's `mock.module` is
 * process-wide and would interfere with `provider.test.ts`, which installs
 * richer SDK stubs (see CLAUDE.md on test isolation).
 */
import { expect, mock, test } from 'bun:test';

let copilotSdkLoaded = false;

mock.module('@github/copilot-sdk', () => {
  copilotSdkLoaded = true;
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

  // If this fails, someone reintroduced a static `import { ... } from
  // '@github/copilot-sdk'` somewhere in the module chain reachable from
  // `registerCommunityProviders()`. Fix by moving that value import inside
  // `CopilotProvider.sendQuery()` (or a helper it calls).
  expect(copilotSdkLoaded).toBe(false);
});
