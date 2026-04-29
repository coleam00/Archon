/**
 * Regression test: Pi SDK must not load at module-import time.
 *
 * Pi's `@mariozechner/pi-coding-agent/dist/config.js` runs
 * `readFileSync(getPackageJsonPath(), 'utf-8')` at module top-level. Inside
 * a compiled Archon binary `getPackageJsonPath()` resolves to
 * `dirname(process.execPath) + '/package.json'`, which doesn't exist — so
 * any static import chain from `@archon/providers` into the Pi SDK crashes
 * archon at startup with ENOENT before any command runs (v0.3.7 symptom).
 *
 * Detection strategy: replace both Pi SDK packages with `mock.module`
 * factories that flip a boolean the first time something resolves them.
 * Walk the same registration path the CLI and server take and assert
 * neither flag tipped. A throwing factory would abort the failing import
 * before the `expect` calls run, producing a crash at resolution time with
 * no assertion context — counters keep failures actionable.
 *
 * Runs in its own `bun test` invocation because Bun's `mock.module` is
 * process-wide and would poison `provider.test.ts`, which installs benign
 * stubs for the same modules (see CLAUDE.md on test isolation).
 */
import { expect, mock, test } from 'bun:test';

// Counter-based detection — see the file header for why not `throw`.
let piCodingAgentLoaded = false;
let piAiLoaded = false;

mock.module('@mariozechner/pi-coding-agent', () => {
  piCodingAgentLoaded = true;
  return {};
});
mock.module('@mariozechner/pi-ai', () => {
  piAiLoaded = true;
  return {};
});

test('registering and instantiating the Pi provider does not eagerly load the Pi SDK', async () => {
  // Go through the same public entrypoint the CLI and server call.
  // `registerCommunityProviders()` pulls in the full registration path
  // (registry.ts → registration.ts → provider.ts → provider's helpers).
  const { clearRegistry, getAgentProvider, registerCommunityProviders } =
    await import('../../registry');

  clearRegistry();
  registerCommunityProviders();

  const provider = getAgentProvider('pi');
  expect(provider.getType()).toBe('pi');
  expect(provider.getCapabilities()).toBeDefined();

  // If either of these fails, someone reintroduced a static (non-type)
  // `import { ... }` from a Pi SDK package somewhere in the module chain
  // reachable from `registerCommunityProviders()`. Fix by moving that value
  // import inside `PiProvider.sendQuery()`'s dynamic-import block.
  expect(piCodingAgentLoaded).toBe(false);
  expect(piAiLoaded).toBe(false);
});
