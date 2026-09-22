/**
 * Unit tests for the once-per-process OAuth flow registration
 * (`ensurePiOAuthFlowsRegistered`) that lets a compiled Archon binary resolve
 * Pi `type: "oauth"` credentials (openai-codex, anthropic, github-copilot, …).
 *
 * The real registration dynamically imports `@earendil-works/pi-ai/bun-oauth`
 * and calls `registerBunOAuthFlows()`. That Bun's `--compile` actually embeds
 * the flow modules behind that string-literal specifier is proven by running a
 * compiled binary, not here. These tests cover the surrounding contract with an
 * injected registrar (DI, no `mock.module` of the Pi SDK): the registrar runs
 * exactly once across concurrent and repeated calls, and a registrar failure is
 * swallowed with a WARN so API-key Pi backends stay unaffected.
 */
import { afterEach, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// Mock the logger so the swallowed-failure WARN is assertable and provider
// module load stays quiet.
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { ensurePiOAuthFlowsRegistered, resetOAuthFlowRegistrationForTest } from './provider';

afterEach(() => {
  resetOAuthFlowRegistrationForTest();
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
});

test('runs the registrar once across concurrent and repeated calls', async () => {
  const registrar = mock(async () => undefined);

  // Concurrent calls before the first resolves must coalesce onto one
  // registrar invocation (they share the cached promise).
  await Promise.all([
    ensurePiOAuthFlowsRegistered(registrar),
    ensurePiOAuthFlowsRegistered(registrar),
    ensurePiOAuthFlowsRegistered(registrar),
  ]);
  // A later call after resolution reuses the cache too.
  await ensurePiOAuthFlowsRegistered(registrar);

  expect(registrar).toHaveBeenCalledTimes(1);
});

test('returns the identical cached promise on every call', () => {
  const registrar = mock(async () => undefined);
  const first = ensurePiOAuthFlowsRegistered(registrar);
  const second = ensurePiOAuthFlowsRegistered(registrar);
  expect(second).toBe(first);
});

test('swallows a registrar failure and logs a WARN (API-key backends unaffected)', async () => {
  const registrar = mock(async () => {
    throw new Error('bun-oauth import blew up');
  });

  // Must resolve, not reject — an OAuth-only registration failure must never
  // break API-key or models.json Pi backends.
  await expect(ensurePiOAuthFlowsRegistered(registrar)).resolves.toBeUndefined();
  expect(registrar).toHaveBeenCalledTimes(1);
  expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  const [fields, event] = mockLogger.warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(event).toBe('pi.oauth_flows_register_failed');
  expect(fields.err).toBeInstanceOf(Error);
});

test('logs a DEBUG breadcrumb on successful registration', async () => {
  const registrar = mock(async () => undefined);
  await ensurePiOAuthFlowsRegistered(registrar);
  expect(mockLogger.debug).toHaveBeenCalledTimes(1);
  expect(mockLogger.debug.mock.calls[0][0]).toBe('pi.oauth_flows_register_completed');
});
