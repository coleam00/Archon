import type { MessageChunk } from '../../types';
import { classifyError } from '../../shared/classify-error';
import { bridgeSession, type BridgeNotifier } from './event-bridge';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent';

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

function jitteredDelay(attempt: number): number {
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function* bridgeSessionWithRetry(
  session: AgentSession,
  prompt: string,
  abortSignal?: AbortSignal,
  outputSchema?: Record<string, unknown>,
  uiBridge?: BridgeNotifier,
  options?: { maxAttempts?: number }
): AsyncGenerator<MessageChunk> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      yield* bridgeSession(session, prompt, abortSignal, outputSchema, uiBridge);
      return;
    } catch (err: unknown) {
      lastError = err as Error;
      const kind = classifyError(lastError);
      const isLast = attempt >= maxAttempts - 1;
      if (kind !== 'TRANSIENT' || isLast) {
        throw lastError;
      }
      const delayMs = jitteredDelay(attempt);
      yield {
        type: 'system',
        content: `⚠️ OMP transient error (attempt ${String(attempt + 1)}/${String(maxAttempts)}): ${lastError.message}. Retrying in ${String(Math.round(delayMs / 1000))}s…`,
      };
      await sleep(delayMs);
    }
  }

  if (lastError) throw lastError;
}
