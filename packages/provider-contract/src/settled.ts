import { z } from 'zod';
import type { ProviderChunk } from './events';

/**
 * The provider's signal that a turn is over: no more work runs for it and nothing
 * follows. A provider sends it once, as the last chunk, after the turn's final `result`,
 * whether the turn succeeded or failed. It is separate from `result` because a result can
 * arrive while work the turn started is still running (Claude reports a `result` while
 * background agents are live, then a later `result` once they drain). The engine
 * finishes a node on `settled`, not on `result`. Every observed subtask must have
 * ended as reported by the runtime. Cancellation or lost observation never settles.
 */
export const providerSettledSchema = z.object({ type: z.literal('settled') });
export type ProviderSettled = z.infer<typeof providerSettledSchema>;

export function awaitingTurnSettlement(wasAwaiting: boolean, chunk: ProviderChunk): boolean {
  if (chunk.type === 'result') return true;
  if (
    (chunk.type === 'state_update' && chunk.state === 'running') ||
    chunk.type === 'tool_call' ||
    (chunk.type === 'subtask' && chunk.status === 'started')
  )
    return false;
  return wasAwaiting;
}
