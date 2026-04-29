/**
 * Regression test: Copilot SDK must not load at module-import time.
 *
 * Pi's `@mariozechner/pi-coding-agent/dist/config.js` runs file I/O at
 * top-level, which crashes compiled Archon binaries at startup with ENOENT
 * (#1355, v0.3.7). `@github/copilot-sdk` has not been audited for the same
 * pattern; treating it as if it might do the same is the conservative
 * default. Any static value-import from `@github/copilot-sdk` reachable from
 * `registerCommunityProviders()` defeats this guarantee.
 *
 * Detection strategy: replace `@github/copilot-sdk` with a `mock.module`
 * factory that flips a boolean the first time something resolves it. Walk the
 * same registration path the CLI and server take and assert the flag did not
 * tip. A throwing factory would abort the failing import before the `expect`
 * runs, producing a crash at resolution time with no assertion context — the
 * counter keeps failures actionable.
 *
 * Runs in its own `bun test` invocation because Bun's `mock.module` is
 * process-wide and would poison `provider.test.ts`, which installs a benign
 * stub for the same module (see CLAUDE.md on test isolation).
 */
import { expect, mock, test } from 'bun:test';

let copilotSdkLoaded = false;

mock.module('@github/copilot-sdk', () => {
  copilotSdkLoaded = true;
  return {};
});

test('registering and instantiating the Copilot provider does not eagerly load the Copilot SDK', async () => {
  const { clearRegistry, getAgentProvider, registerCommunityProviders } =
    await import('../../registry');

  clearRegistry();
  registerCommunityProviders();

  const provider = getAgentProvider('copilot');
  expect(provider.getType()).toBe('copilot');
  expect(provider.getCapabilities()).toBeDefined();

  // If this fails, someone reintroduced a static (non-type) import from
  // `@github/copilot-sdk` somewhere in the module chain reachable from
  // `registerCommunityProviders()`. Fix by moving the value import inside
  // `CopilotProvider.sendQuery()`'s dynamic-import block.
  expect(copilotSdkLoaded).toBe(false);
});
