import type { MessageChunk } from '../types';

/**
 * Closes, as `cancelled`, the tool calls a provider's stream started and never closed. The
 * contract makes the provider state how every call ended (rule 2 of `checkEventVocabulary`),
 * so the engine never has to invent a completion. A call is closed when its turn ends:
 *  - before a `result`, when `resultEndsTurn` is set. Claude clears it, because its result
 *    can arrive while background agents still run tools that close later;
 *  - before a `result` that carries a failure, since a failed turn runs nothing more;
 *  - before `settled`, at the end of the stream, and before a thrown error propagates
 *    (an abort throws).
 */
export async function* closeOpenToolCalls(
  stream: AsyncIterable<MessageChunk>,
  { resultEndsTurn }: { resultEndsTurn: boolean }
): AsyncGenerator<MessageChunk> {
  const open = new Set<string>();
  function* cancelOpen(): Generator<MessageChunk> {
    for (const toolCallId of open) {
      yield { type: 'tool_call_update', toolCallId, status: 'cancelled' };
    }
    open.clear();
  }
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'tool_call') open.add(chunk.toolCallId);
      else if (chunk.type === 'tool_call_update') open.delete(chunk.toolCallId);
      else if (
        chunk.type === 'settled' ||
        (chunk.type === 'result' && (resultEndsTurn || chunk.failure !== undefined))
      ) {
        yield* cancelOpen();
      }
      yield chunk;
    }
  } catch (error) {
    yield* cancelOpen();
    throw error;
  }
  yield* cancelOpen();
}
