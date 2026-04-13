/**
 * Pi AI SDK wrapper
 * Provides async generator interface for streaming Pi responses.
 *
 * Pi wraps 15+ LLM providers (Google, Mistral, Groq, xAI, OpenRouter, etc.)
 * through a single unified API. Model strings use `pi:<provider>/<modelId>` format.
 */
import {
  streamSimple,
  getModel,
  type AssistantMessageEvent,
  type SimpleStreamOptions,
  type Model,
  type Api,
  type Context,
} from '@mariozechner/pi-ai';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  TokenUsage,
  ProviderCapabilities,
} from '../types';
import { parsePiConfig } from './config';
import { PI_CAPABILITIES } from './capabilities';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

/**
 * Parse a `pi:<provider>/<modelId>` string into its components.
 * Returns undefined if the string doesn't match the expected format.
 */
export function parsePiModelString(
  model: string
): { provider: string; modelId: string } | undefined {
  if (!model.startsWith('pi:')) return undefined;
  const rest = model.slice(3);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0 || slashIdx === rest.length - 1) return undefined;
  return { provider: rest.slice(0, slashIdx), modelId: rest.slice(slashIdx + 1) };
}

/**
 * Resolve a Pi model from the model string.
 * Supports both `pi:<provider>/<modelId>` format and raw model strings
 * (which fall back to assistantConfig model or a default).
 */
function resolveModel(
  requestModel: string | undefined,
  configModel: string | undefined
): Model<Api> {
  const modelString = requestModel ?? configModel;
  if (!modelString) {
    throw new Error(
      'Pi provider requires a model in pi:<provider>/<modelId> format. ' +
        'Set it in workflow YAML (model: pi:google/gemini-2.5-pro) or ' +
        'config.yaml (assistants.pi.model: pi:google/gemini-2.5-pro).'
    );
  }

  const parsed = parsePiModelString(modelString);
  if (!parsed) {
    throw new Error(
      `Invalid Pi model format: "${modelString}". ` +
        'Expected pi:<provider>/<modelId> (e.g. pi:google/gemini-2.5-pro).'
    );
  }

  try {
    // getModel is typed with KnownProvider/known model IDs, but accepts any string at runtime
    return getModel(parsed.provider as 'google', parsed.modelId as 'gemini-2.5-pro');
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to resolve Pi model "${modelString}": ${err.message}. ` +
        'Check that the provider and model ID are correct.'
    );
  }
}

// ─── Stream Normalizer ───────────────────────────────────────────────────

/**
 * Normalize Pi AI SDK events into Archon MessageChunks.
 * Pi uses an async iterable event stream with typed discriminated union events.
 */
async function* streamPiEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  for await (const event of events) {
    if (abortSignal?.aborted) {
      getLog().info('query_aborted_between_events');
      throw new Error('Query aborted');
    }

    switch (event.type) {
      case 'text_delta':
        yield { type: 'assistant', content: event.delta };
        break;

      case 'thinking_delta':
        yield { type: 'thinking', content: event.delta };
        break;

      case 'toolcall_end':
        yield {
          type: 'tool',
          toolName: event.toolCall.name,
          toolInput: event.toolCall.arguments,
          toolCallId: event.toolCall.id,
        };
        break;

      case 'done': {
        const usage = event.message.usage;
        const tokens: TokenUsage = {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cost: usage.cost.total,
        };
        yield {
          type: 'result',
          tokens,
          stopReason: event.reason,
          cost: usage.cost.total,
        };
        break;
      }

      case 'error': {
        const errorMessage = event.error.errorMessage ?? 'Unknown Pi error';
        getLog().error({ errorMessage, reason: event.reason }, 'stream_error');

        const usage = event.error.usage;
        const tokens: TokenUsage = {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cost: usage.cost.total,
        };

        yield { type: 'system', content: `❌ Pi error: ${errorMessage}` };
        yield {
          type: 'result',
          tokens,
          isError: true,
          stopReason: event.reason,
          cost: usage.cost.total,
        };
        break;
      }

      // start, text_start, text_end, thinking_start, thinking_end, toolcall_start, toolcall_delta
      // are partial/structural events — no MessageChunk needed
      default:
        break;
    }
  }
}

// ─── Pi Provider ──────────────────────────────────────────────────────

/**
 * Pi AI agent provider.
 * Implements IAgentProvider with Pi AI SDK integration.
 *
 * Pi wraps 15+ LLM providers through a single unified API.
 * Model format: pi:<provider>/<modelId> (e.g. pi:google/gemini-2.5-pro)
 */
export class PiProvider implements IAgentProvider {
  getCapabilities(): ProviderCapabilities {
    return PI_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const piConfig = parsePiConfig(assistantConfig);

    // 1. Resolve model
    const model = resolveModel(requestOptions?.model, piConfig.model);

    getLog().info(
      { cwd, provider: model.provider, modelId: model.id, api: model.api },
      'query_started'
    );

    if (requestOptions?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    // 2. Build context
    const context: Context = {
      systemPrompt: requestOptions?.systemPrompt,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    };

    // 3. Build stream options
    const streamOptions: SimpleStreamOptions = {};
    if (requestOptions?.abortSignal) {
      streamOptions.signal = requestOptions.abortSignal;
    }

    // 4. Stream response
    const eventStream = streamSimple(model, context, streamOptions);
    yield* streamPiEvents(eventStream, requestOptions?.abortSignal);
  }

  getType(): string {
    return 'pi';
  }
}
