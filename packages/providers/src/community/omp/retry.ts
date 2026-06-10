import type { MessageChunk } from '../../types';
import { classifyError } from '../../shared/classify-error';
import { bridgeSession, type BridgeNotifier } from './event-bridge';
import { OmpEnrichedError, type OmpDiagnosticsContext } from './diagnostics';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent';

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

function jitteredDelay(attempt: number, baseDelayMs: number): number {
  const exp = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * Math.min(500, baseDelayMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface BridgeRetryOptions {
  maxAttempts?: number;
  /** Shared per-query diagnostics ledger (threaded into each bridge attempt). */
  diagnostics?: OmpDiagnosticsContext;
  /** Test hook: base backoff delay (default 1000ms). */
  baseDelayMs?: number;
}

/**
 * Run `bridgeSession` with pre-stream-failure retry.
 *
 * Takes a session FACTORY, not a session: `bridgeSession` always disposes its
 * session in a `finally`, so retrying with the same instance would prompt a
 * disposed session (the bug shipped in 70eaa443). Each attempt gets a fresh
 * session from the factory.
 *
 * Retry is permitted only when ALL of:
 * - zero chunks were yielded during the current attempt (pre-stream failure —
 *   retrying after output would duplicate chunks and side effects),
 * - `classifyError(err) === 'TRANSIENT'`,
 * - attempts remain.
 *
 * Mid-stream failures throw the (already enriched) error immediately.
 */
export async function* bridgeSessionWithRetry(
  sessionFactory: () => Promise<AgentSession>,
  prompt: string,
  abortSignal?: AbortSignal,
  outputSchema?: Record<string, unknown>,
  uiBridge?: BridgeNotifier,
  options?: BridgeRetryOptions
): AsyncGenerator<MessageChunk> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? BASE_DELAY_MS;
  const diagnostics = options?.diagnostics;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let chunksYieldedThisAttempt = 0;
    try {
      const session = await sessionFactory();
      for await (const chunk of bridgeSession(
        session,
        prompt,
        abortSignal,
        outputSchema,
        uiBridge,
        {
          ...(diagnostics ? { diagnostics } : {}),
        }
      )) {
        chunksYieldedThisAttempt += 1;
        yield chunk;
      }
      return;
    } catch (err: unknown) {
      lastError = err as Error;
      const kind = classifyError(lastError);
      const isLast = attempt >= maxAttempts - 1;
      if (chunksYieldedThisAttempt > 0 || kind !== 'TRANSIENT' || isLast) {
        throw lastError;
      }
      const delayMs = jitteredDelay(attempt, baseDelayMs);
      // Enriched bridge errors already carry the ledger summary in their
      // message — only append it for raw (e.g. session-factory) failures.
      const ledgerSummary =
        diagnostics &&
        diagnostics.getAttempts().length > 0 &&
        !(lastError instanceof OmpEnrichedError)
          ? ` ${diagnostics.formatForErrorMessage()}`
          : '';
      yield {
        type: 'system',
        content: `⚠️ OMP transient error before any output (attempt ${String(attempt + 1)}/${String(maxAttempts)}): ${lastError.message}. Retrying with a fresh session in ${String(Math.round(delayMs / 1000))}s…${ledgerSummary}`,
      };
      await sleep(delayMs);
    }
  }

  // Unreachable: the last attempt always returns or throws above. Kept as a
  // typed safety net.
  if (lastError) throw lastError;
}
