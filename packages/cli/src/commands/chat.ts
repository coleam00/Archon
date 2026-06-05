/**
 * CLI chat command — send a message to the orchestrator agent
 *
 * Single-shot: streams response to stdout and exits.
 * Multi-turn conversations happen via the web UI.
 */
import { CLIAdapter } from '../adapters/cli-adapter';
import { handleMessage } from '@archon/core';

/**
 * Execute a single-shot orchestrator chat message.
 * Creates a unique conversation, streams the response to stdout, and returns.
 */
export async function chatCommand(message: string): Promise<void> {
  const adapter = new CLIAdapter({ streamingMode: 'batch' });
  const conversationId = `cli-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // TODO: thread userId once the CLI auth path lands. handleMessage will then
  // receive { userId } via HandleMessageContext and the conversation row will
  // be attributed to the local operator.
  await handleMessage(adapter, conversationId, message);
}
