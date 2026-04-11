/**
 * Pi.dev Agent SDK wrapper (https://pi.dev)
 * Provides async generator interface for streaming Pi coding agent responses.
 *
 * Authentication:
 * - OAuth login (stored in ~/.pi/agent/auth.json after `pi /login`)
 * - API key env vars: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, etc.
 *   Pi supports many providers; see https://pi.dev docs for the full list.
 *
 * Model format:
 * - Provide `provider/model-id` in AssistantRequestOptions.model
 *   e.g. "anthropic/claude-opus-4-5", "openai/gpt-4o", "google/gemini-2.5-pro"
 * - Omit to use Pi's auto-selected default (based on available API keys)
 *
 * Pi SDK bridging:
 * - Pi SDK uses event subscription (`session.subscribe(callback)`)
 * - This client bridges that to Archon's `AsyncGenerator<MessageChunk>` interface
 *   via a queue-based adapter pattern.
 */
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import type { AssistantRequestOptions, IAssistantClient, MessageChunk } from '../types';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.pi');
  return cachedLog;
}

/**
 * Serialize a pi tool result to a display string.
 * Results can be strings, objects, or null/undefined.
 */
function serializeToolResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    // Pi tool results often have an `output` field (bash tool)
    const obj = result as Record<string, unknown>;
    if (typeof obj['output'] === 'string') return obj['output'];
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/**
 * Pi.dev coding agent client.
 * Implements generic IAssistantClient interface using the @mariozechner/pi-coding-agent SDK.
 *
 * Pi supports many LLM providers (Anthropic, OpenAI, Google, and more).
 * Set the relevant API key env var and specify the model in provider/model-id format.
 */
export class PiClient implements IAssistantClient {
  getType(): string {
    return 'pi';
  }

  /**
   * Send a query to the Pi coding agent and stream responses.
   *
   * @param prompt - User message or prompt
   * @param cwd - Working directory for the agent's file tools
   * @param resumeSessionId - Not supported by Pi; a warning is logged and execution proceeds fresh
   * @param options - Optional request options. `model` should be in "provider/model-id" format.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    if (resumeSessionId) {
      getLog().warn(
        { resumeSessionId },
        'pi.session_resume_not_supported — starting fresh session'
      );
    }

    // Check if already aborted
    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    // Resolve model from options: parse "provider/model-id" format
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    let model: ReturnType<typeof modelRegistry.find> | undefined;
    if (options?.model) {
      const slashIdx = options.model.indexOf('/');
      if (slashIdx > 0) {
        const provider = options.model.slice(0, slashIdx);
        const modelId = options.model.slice(slashIdx + 1);
        model = modelRegistry.find(provider, modelId);
        if (!model) {
          getLog().warn(
            { model: options.model },
            'pi.model_not_found_in_registry — using auto-selected default'
          );
        }
      } else {
        getLog().warn(
          { model: options.model },
          'pi.model_format_invalid — expected "provider/model-id" format, using auto-selected default'
        );
      }
    }

    // Create a Pi coding agent session scoped to the cwd.
    // SessionManager.inMemory() prevents Pi from persisting sessions to disk
    // (Archon manages its own session state in its database).
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(),
      tools: createCodingTools(cwd),
      ...(model !== undefined ? { model } : {}),
    });

    // Set up abort signal handling
    let abortRegistered = false;
    const abortHandler = (): void => {
      session.abort().catch((err: unknown) => {
        getLog().warn({ err }, 'pi.session_abort_failed');
      });
    };
    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      abortRegistered = true;
    }

    // Queue for bridging event callbacks to async generator
    const chunks: MessageChunk[] = [];
    let notifyNext: (() => void) | null = null;
    let done = false;
    let promptError: Error | undefined;

    const notify = (): void => {
      const fn = notifyNext;
      notifyNext = null;
      fn?.();
    };

    const enqueue = (chunk: MessageChunk): void => {
      chunks.push(chunk);
      notify();
    };

    // Subscribe to Pi SDK events and map them to Archon MessageChunk types
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent;
        if (ae.type === 'text_delta') {
          enqueue({ type: 'assistant', content: ae.delta });
        } else if (ae.type === 'thinking_delta') {
          enqueue({ type: 'thinking', content: ae.delta });
        }
      } else if (event.type === 'tool_execution_start') {
        // event.args is typed `any` in pi-agent-core — normalize to Record<string, unknown>
        const toolInput: Record<string, unknown> =
          event.args !== null && typeof event.args === 'object'
            ? (event.args as Record<string, unknown>)
            : {};
        enqueue({
          type: 'tool',
          toolName: event.toolName,
          toolInput,
          toolCallId: event.toolCallId,
        });
      } else if (event.type === 'tool_execution_end') {
        // event.result is typed `any` in pi-agent-core — serialize to string
        const toolOutput = event.isError
          ? `Error: ${serializeToolResult(event.result)}`
          : serializeToolResult(event.result);
        enqueue({
          type: 'tool_result',
          toolName: event.toolName,
          toolOutput,
          toolCallId: event.toolCallId,
        });
      } else if (event.type === 'agent_end') {
        done = true;
        notify();
      }
    });

    // Start the prompt; errors are captured and re-thrown after the generator finishes
    session.prompt(prompt).catch((err: unknown) => {
      promptError = err instanceof Error ? err : new Error(String(err));
      done = true;
      notify();
    });

    try {
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else {
          await new Promise<void>(resolve => {
            notifyNext = resolve;
          });
        }
      }

      if (promptError) throw promptError;

      yield { type: 'result' };
    } finally {
      unsubscribe();
      if (abortRegistered && options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
      session.dispose();
    }
  }
}
