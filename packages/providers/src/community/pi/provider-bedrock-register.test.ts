/**
 * Unit tests for the once-per-process Bedrock backend registration
 * (`ensureBedrockProviderRegistered`) that lets a compiled Archon binary load
 * `amazon-bedrock/*` Pi models (issue #2154).
 *
 * The real registration dynamically imports `@earendil-works/pi-ai/compat` and
 * `@earendil-works/pi-ai/bedrock-provider` and calls `setBedrockProviderModule`.
 * That wiring — and, critically, that Bun's `--compile` actually bundles those
 * string-literal specifiers — is proven by the live compiled-binary check in the
 * PR, not here. These tests cover the surrounding contract with an injected
 * registrar (DI, no `mock.module` of the Pi SDK): the registrar runs exactly
 * once across concurrent and repeated calls, and a registrar failure is
 * swallowed with a WARN so non-Bedrock Pi backends stay unaffected.
 */
import { afterEach, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// Mock the logger so the swallowed-failure WARN is assertable and provider
// module load stays quiet.
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { ensureBedrockProviderRegistered, resetBedrockRegistrationForTest } from './provider';

afterEach(() => {
  resetBedrockRegistrationForTest();
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
});

test('runs the registrar once across concurrent and repeated calls', async () => {
  let calls = 0;
  const registrar = mock(async () => {
    calls++;
  });

  // Three concurrent calls before the first resolves must still coalesce onto
  // one registrar invocation (they share the cached promise).
  await Promise.all([
    ensureBedrockProviderRegistered(registrar),
    ensureBedrockProviderRegistered(registrar),
    ensureBedrockProviderRegistered(registrar),
  ]);
  // A later call after resolution reuses the cache too.
  await ensureBedrockProviderRegistered(registrar);

  expect(calls).toBe(1);
  expect(registrar).toHaveBeenCalledTimes(1);
});

test('returns the identical cached promise on every call', () => {
  const registrar = mock(async () => undefined);
  const first = ensureBedrockProviderRegistered(registrar);
  const second = ensureBedrockProviderRegistered(registrar);
  expect(second).toBe(first);
});

test('swallows a registrar failure and logs a WARN (non-Bedrock nodes unaffected)', async () => {
  const registrar = mock(async () => {
    throw new Error('bedrock import blew up');
  });

  // Must resolve, not reject — a Bedrock-only registration failure must never
  // break anthropic/*, cursor/*, or any other Pi backend.
  await expect(ensureBedrockProviderRegistered(registrar)).resolves.toBeUndefined();
  expect(registrar).toHaveBeenCalledTimes(1);
  expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  const [fields, event] = mockLogger.warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(event).toBe('pi.bedrock_provider_register_failed');
  expect(fields.err).toBeInstanceOf(Error);
});

test('logs a DEBUG breadcrumb on successful registration', async () => {
  const registrar = mock(async () => undefined);
  await ensureBedrockProviderRegistered(registrar);
  expect(mockLogger.debug).toHaveBeenCalledTimes(1);
  expect(mockLogger.debug.mock.calls[0][0]).toBe('pi.bedrock_provider_register_completed');
});
