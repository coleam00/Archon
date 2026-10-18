import type { ProviderEvent } from '@archon/provider-contract';

export type ReplyChunk = Pick<
  Extract<ProviderEvent, { type: 'agent_message_chunk' }>,
  'text' | 'continuesPreviousBlock'
>;

export function shiftReplyChunk(chunks: ReplyChunk[]): void {
  const oldest = chunks.shift();
  const next = chunks[0];
  // A retained continuation needs its opener to classify indicator sections.
  if (oldest && next?.continuesPreviousBlock) {
    chunks[0] = { ...oldest, text: oldest.text + next.text };
  }
}

function replyChunks(chunks: readonly (ReplyChunk | string)[]): ReplyChunk[] {
  return chunks.map(chunk => (typeof chunk === 'string' ? { text: chunk } : chunk));
}

function replyBlocks(chunks: readonly ReplyChunk[]): string[] {
  const assistantMessages: string[] = [];
  for (const chunk of chunks) {
    const previous = assistantMessages.length - 1;
    if (chunk.continuesPreviousBlock && previous >= 0) assistantMessages[previous] += chunk.text;
    else assistantMessages.push(chunk.text);
  }
  return assistantMessages;
}

export function filterToolIndicators(input: readonly (ReplyChunk | string)[]): string {
  const blocks = replyBlocks(replyChunks(input));
  const separator = '\n\n---\n\n';

  const toolIndicatorRegex =
    /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;

  // Filter per message so a message left empty drops out with its separator;
  // filtering the joined text would keep bare `---` sections as content.
  const finalMessage = blocks
    .map(message =>
      message
        .split('\n\n')
        .filter(section => !toolIndicatorRegex.test(section.trim()))
        .join('\n\n')
    )
    .filter(message => message.trim() !== '')
    .join(separator)
    .trim();

  return finalMessage || blocks.join(separator);
}
