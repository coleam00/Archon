import type { MessageChunk } from '../types';

/**
 * Wrap a provider's chunk stream so the session-resume outcome is recorded on
 * the terminal `result` chunk(s).
 *
 * `resumed` semantics (mirrors MessageChunk result.resumed):
 *   - `undefined`  no resume was attempted — the stream passes through untouched
 *   - `true`       a resume was requested and the prior session was restored
 *   - `false`      a resume was requested but the provider fell back to a fresh
 *                  (cold) session
 *
 * Stamping it here keeps every provider's wiring to one line and ensures a
 * failed resume is observable downstream (the dag-executor surfaces a warning on
 * `false`) instead of being silently swallowed as a normal fresh turn.
 */
export async function* withResumedOutcome(
  stream: AsyncGenerator<MessageChunk>,
  resumed: boolean | undefined
): AsyncGenerator<MessageChunk> {
  if (resumed === undefined) {
    yield* stream;
    return;
  }
  for await (const chunk of stream) {
    yield chunk.type === 'result' ? { ...chunk, resumed } : chunk;
  }
}

/**
 * Compute the `resumed` argument for {@link withResumedOutcome}.
 *
 * Returns `undefined` when no resume was attempted (so the stream passes through
 * untouched); otherwise returns whether the resume succeeded. Centralizes the
 * "undefined means no resume was requested" guard that every provider shares.
 */
export function resumedOutcome(
  resumeSessionId: string | undefined,
  succeeded: boolean
): boolean | undefined {
  if (resumeSessionId === undefined) {
    return undefined;
  }
  return succeeded;
}
