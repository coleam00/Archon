import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { generateConversationId } from '../utils/conversation-id';
import { CLIAdapter } from '../adapters/cli-adapter';
import { handleMessage } from '@archon/core';

export async function chatCommand(
  message?: string,
  input: Readable = process.stdin
): Promise<void> {
  const adapter = new CLIAdapter({ streamingMode: 'batch' });
  const conversationId = generateConversationId('cli-chat');
  const terminal = input === process.stdin && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const lines = createInterface({ input, output: process.stdout, terminal, prompt: 'archon> ' });
  // Subscribe before the first turn: piped follow-ups can arrive while it is running.
  const messages = lines[Symbol.asyncIterator]();
  let interrupted = false;
  lines.on('SIGINT', () => {
    interrupted = true;
    lines.close();
  });
  const send = async (text: string): Promise<void> => {
    await handleMessage(adapter, conversationId, text, { actor: { kind: 'operator' } });
    if (terminal && !interrupted) lines.prompt();
  };
  try {
    if (message) await send(message);
    else if (terminal) lines.prompt();
    for await (const text of messages) {
      if (interrupted) break;
      if (text.trim() === '/exit' || text.trim() === '/quit') break;
      if (text.trim()) await send(text);
    }
  } finally {
    lines.close();
  }
}
