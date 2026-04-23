import type { MessageChunk } from '../../types';

// Type-only imports from OpenCode SDK to avoid runtime deps at module load.
// The actual SDK is dynamically imported inside sendQuery().
type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient;
type Event = import('@opencode-ai/sdk').Event;

/**
 * Bridge OpenCode SSE events to Archon MessageChunk async generator.
 *
 * OpenCode event flow for a single prompt:
 *   1. message.part.updated (text delta) → assistant chunks
 *   2. message.part.updated (reasoning) → thinking chunks
 *   3. message.part.updated (tool call) → tool chunks
 *   4. message.part.updated (tool result) → tool_result chunks
 *   5. message.updated (assistant complete) → result chunk with tokens
 *   6. session.error → result chunk with isError
 */
export async function* bridgeEvents(
  client: OpencodeClient,
  sessionId: string,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const events = await client.event.subscribe();

  const accumulatedTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let totalCost = 0;

  try {
    for await (const event of events.stream) {
      if (abortSignal?.aborted) {
        try {
          await client.session.abort({ path: { id: sessionId } });
        } catch {
          // Ignore abort errors
        }
        throw new Error('Aborted');
      }

      const chunk = mapEventToChunk(event);
      if (!chunk) continue;

      // Accumulate token usage from result chunks for final tally
      if (chunk.type === 'result' && chunk.tokens) {
        accumulatedTokens.input += chunk.tokens.input ?? 0;
        accumulatedTokens.output += chunk.tokens.output ?? 0;
      }
      if (chunk.type === 'result' && typeof chunk.cost === 'number') {
        totalCost += chunk.cost;
      }

      yield chunk;

      // Stop consuming on final result or error
      if (chunk.type === 'result') {
        return;
      }
    }
  } finally {
    // Ensure the SSE stream is cancelled
    try {
      await events.stream.return?.(undefined);
    } catch {
      // Ignore cleanup errors
    }
  }

  // If the stream ends without a result chunk, yield one with accumulated stats
  yield {
    type: 'result',
    sessionId,
    tokens: {
      input: accumulatedTokens.input,
      output: accumulatedTokens.output,
    },
    cost: totalCost > 0 ? totalCost : undefined,
  };
}

function mapEventToChunk(event: Event): MessageChunk | undefined {
  switch (event.type) {
    case 'message.part.updated': {
      const part = event.properties.part;
      const delta = event.properties.delta;

      if (part.type === 'text') {
        return {
          type: 'assistant',
          content: delta ?? part.text ?? '',
        };
      }

      if (part.type === 'reasoning') {
        return {
          type: 'thinking',
          content: delta ?? part.text ?? '',
        };
      }

      if (part.type === 'tool') {
        const state = part.state;
        if (state.status === 'pending' || state.status === 'running') {
          return {
            type: 'tool',
            toolName: part.tool,
            toolInput: state.input,
            toolCallId: part.callID,
          };
        }
        // Completed tool calls are reported via tool_result
        if (state.status === 'completed') {
          return {
            type: 'tool_result',
            toolName: part.tool,
            toolOutput: JSON.stringify(state.output ?? state.input ?? {}),
            toolCallId: part.callID,
          };
        }
        return undefined;
      }

      // Other part types (file, agent, subtask, etc.) are ignored for now
      return undefined;
    }

    case 'message.updated': {
      const info = event.properties.info;
      if (info.role === 'assistant') {
        const tokens = info.tokens;
        return {
          type: 'result',
          sessionId: info.sessionID,
          tokens: {
            input: tokens?.input ?? 0,
            output: tokens?.output ?? 0,
            total: tokens ? tokens.input + tokens.output + tokens.reasoning : undefined,
          },
          cost: info.cost > 0 ? info.cost : undefined,
        };
      }
      return undefined;
    }

    case 'session.error': {
      const error = event.properties.error;
      let errorMessage = 'Unknown OpenCode error';
      if (error) {
        if ('data' in error && error.data && typeof error.data === 'object') {
          errorMessage =
            (error.data as { message?: string }).message ?? error.name ?? 'Unknown error';
        } else {
          errorMessage = error.name ?? 'Unknown error';
        }
      }
      return {
        type: 'result',
        isError: true,
        errors: [errorMessage],
        sessionId: event.properties.sessionID,
      };
    }

    case 'session.status':
    case 'session.idle':
    case 'session.compacted':
    case 'file.edited':
    case 'todo.updated':
    case 'command.executed':
    case 'message.removed':
    case 'message.part.removed':
    case 'permission.updated':
    case 'permission.replied':
    case 'lsp.updated':
    case 'lsp.client.diagnostics':
    case 'file.watcher.updated':
    case 'vcs.branch.updated':
    case 'tui.prompt.append':
    case 'tui.command.execute':
    case 'tui.toast.show':
    case 'pty.created':
    case 'pty.updated':
    case 'pty.exited':
    case 'pty.deleted':
    case 'server.connected':
    case 'server.instance.disposed':
    case 'installation.updated':
    case 'installation.update-available':
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
    case 'session.diff':
      // Intentionally ignored — not relevant to Archon's MessageChunk contract
      return undefined;

    default:
      // Exhaustiveness fallback
      return undefined;
  }
}
