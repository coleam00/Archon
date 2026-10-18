import type { MessageChunk } from '../../types';

type TextChunk = Extract<MessageChunk, { type: 'agent_message_chunk' | 'agent_thought_chunk' }>;

/** Coalesce Pi deltas while preserving reply identity across immediate warnings. */
export function createTextBlockBuffer(emit: (chunk: MessageChunk) => void) {
  let pending: TextChunk | undefined;
  let continuedType: TextChunk['type'] | undefined;
  const takePending = (): TextChunk | undefined => {
    const block = pending;
    pending = undefined;
    return block;
  };
  const flushPending = (continues = false): void => {
    const block = takePending();
    continuedType = continues ? (block?.type ?? continuedType) : undefined;
    if (block) emit(block);
  };
  const appendPending = (
    type: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string
  ): void => {
    if (pending?.type !== type && (pending || continuedType !== type)) flushPending();
    if (pending) pending.text += text;
    else
      pending = {
        type,
        text,
        ...(type === 'agent_message_chunk' && continuedType === type
          ? { continuesPreviousBlock: true }
          : {}),
      };
  };

  return { takePending, flushPending, appendPending };
}
