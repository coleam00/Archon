import type { MessageChunk, TokenUsage } from '../../types';

/**
 * Raw event shape from the opencode SSE stream.
 * The SDK's typed Event union omits 'message.part.delta' and 'server.*'
 * events that the server actually emits, so we widen to unknown and
 * discriminate by type string at runtime.
 */
interface RawEvent {
  type: string;
  properties: Record<string, unknown>;
}

interface RawToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

interface RawPart {
  id?: string;
  type: string;
  sessionID?: string;
  messageID?: string;
  // text / reasoning
  text?: string;
  // tool
  callID?: string;
  tool?: string;
  state?: RawToolState;
  // step-finish
  cost?: number;
  tokens?: { input: number; output: number };
}

/**
 * Bridge the opencode SSE event stream into Archon MessageChunks.
 *
 * Caller responsibilities:
 *   - Subscribe to events BEFORE creating the session (avoids race).
 *   - Pass the session ID to filter out noise from other concurrent sessions
 *     sharing the same opencode server instance.
 *   - Call abortFn when the caller's AbortSignal fires; we wire it internally
 *     so the caller doesn't need to race on signal vs. stream end.
 *
 * Event mapping (opencode → Archon):
 *   message.part.delta {field:'text'}  → { type:'assistant', content: delta }
 *   message.part.updated {reasoning}   → { type:'thinking', content: new-text }
 *   message.part.updated {tool running}→ { type:'tool', toolName, toolInput, toolCallId }
 *   message.part.updated {tool done}   → { type:'tool_result', toolName, toolOutput, toolCallId }
 *   message.part.updated {step-finish} → accumulates tokens / cost
 *   session.idle                       → { type:'result', sessionId, tokens, cost }
 *   session.error                      → { type:'result', isError:true, errors }
 *
 * Note: 'message.part.delta' is not in the SDK's typed Event union but IS
 * emitted by the server (confirmed via smoke-test). We handle it via the
 * RawEvent fallthrough.
 */
export async function* bridgeOpencodeEvents(
  stream: AsyncGenerator,
  sessionId: string,
  outputSchema?: Record<string, unknown>
): AsyncGenerator<MessageChunk> {
  // Track which tool calls/results have been yielded to avoid duplicates.
  const emittedToolCalls = new Set<string>();
  const emittedToolResults = new Set<string>();
  // Reasoning parts send full-text snapshots; track per-partID to yield deltas.
  const reasoningLengths = new Map<string, number>();

  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let assistantText = '';

  for await (const raw of stream) {
    const event = raw as RawEvent;
    if (!event || typeof event.type !== 'string') continue;
    const props = event.properties ?? {};

    // Filter events to the current session.
    // Server-level events (server.connected, server.heartbeat) have no
    // sessionID in properties and are intentionally let through — we don't
    // handle them, so they fall through the switch harmlessly.
    if (typeof props.sessionID === 'string' && props.sessionID !== sessionId) continue;

    switch (event.type) {
      case 'message.part.delta': {
        // Text streaming: not in SDK types but real. Properties:
        // { sessionID, messageID, partID, field: 'text', delta: string }
        if (props.field === 'text' && typeof props.delta === 'string' && props.delta !== '') {
          assistantText += props.delta;
          yield { type: 'assistant', content: props.delta };
        }
        break;
      }

      case 'message.part.updated': {
        const part = props.part as RawPart | undefined;
        if (part?.sessionID !== sessionId) break;

        if (part.type === 'reasoning') {
          // Full-text snapshot; emit only the new suffix.
          const text = typeof part.text === 'string' ? part.text : '';
          const partId = part.id ?? '';
          const prev = reasoningLengths.get(partId) ?? 0;
          if (text.length > prev) {
            yield { type: 'thinking', content: text.slice(prev) };
            reasoningLengths.set(partId, text.length);
          }
        } else if (part.type === 'tool' && part.callID && part.tool && part.state) {
          const { callID, tool, state } = part;
          if (state.status === 'running' && !emittedToolCalls.has(callID)) {
            emittedToolCalls.add(callID);
            yield {
              type: 'tool',
              toolName: tool,
              toolInput: state.input ?? {},
              toolCallId: callID,
            };
          } else if (state.status === 'completed' && !emittedToolResults.has(callID)) {
            emittedToolResults.add(callID);
            yield {
              type: 'tool_result',
              toolName: tool,
              toolOutput: state.output ?? '',
              toolCallId: callID,
            };
          } else if (state.status === 'error' && !emittedToolResults.has(callID)) {
            emittedToolResults.add(callID);
            yield {
              type: 'tool_result',
              toolName: tool,
              toolOutput: `Error: ${state.error ?? 'unknown'}`,
              toolCallId: callID,
            };
          }
        } else if (part.type === 'step-finish') {
          if (part.tokens) {
            inputTokens += part.tokens.input;
            outputTokens += part.tokens.output;
          }
          if (typeof part.cost === 'number') {
            totalCost += part.cost;
          }
        }
        break;
      }

      case 'session.idle': {
        const tokens: TokenUsage = {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        };

        let structuredOutput: unknown = undefined;
        if (outputSchema && assistantText) {
          try {
            // Strip markdown code fences that instruction-following models may add.
            const stripped = assistantText
              .trim()
              .replace(/^```(?:json)?\n?/, '')
              .replace(/\n?```$/, '');
            structuredOutput = JSON.parse(stripped);
          } catch {
            // Parse failure: executor's dag.structured_output_missing path handles it.
          }
        }

        yield {
          type: 'result',
          sessionId,
          tokens,
          cost: totalCost,
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        };
        return;
      }

      case 'session.error': {
        const error = props.error as Record<string, unknown> | undefined;
        const errorMsg =
          (error?.message as string | undefined) ??
          (error?.code as string | undefined) ??
          'opencode session error';
        yield {
          type: 'result',
          sessionId,
          isError: true,
          errors: [errorMsg],
        };
        return;
      }
    }
  }

  // Stream ended without a terminal event — yield a result so the caller
  // gets a complete MessageChunk sequence regardless.
  yield {
    type: 'result',
    sessionId,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
    cost: totalCost,
  };
}

/**
 * Augment a prompt with a "respond with JSON matching this schema" instruction.
 * Used when outputFormat is specified — opencode has no SDK-level JSON mode.
 */
export function augmentPromptForJsonSchema(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY a JSON object matching the schema below. No prose before or after the JSON. No markdown code fences. Just the raw JSON object as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}
