/**
 * Observability module — optional Langfuse integration via OpenTelemetry.
 *
 * When LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set, initializes:
 * - OTel NodeSDK with LangfuseSpanProcessor
 * - Manual tracing of Claude Agent SDK calls with input/output/usage/tool calls
 *
 * When not configured, all exports are safe no-ops with zero overhead.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createLogger } from '@archon/paths';
import type { MessageChunk, TokenUsage } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('observability');
  return cachedLog;
}

// ─── Context Propagation ────────────────────────────────────────────────────

/** Attributes propagated through async call chains via AsyncLocalStorage */
export interface ObservabilityAttrs {
  conversationId?: string;
  platformType?: string;
  workflowName?: string;
}

const store = new AsyncLocalStorage<ObservabilityAttrs>();

/**
 * Run a callback with observability attributes attached.
 * Nested calls merge: inner attrs override outer attrs for the same key.
 */
export function withObservabilityContext<T>(attrs: ObservabilityAttrs, fn: () => T): T {
  const parent = store.getStore();
  const merged = parent ? { ...parent, ...attrs } : attrs;
  return store.run(merged, fn);
}

/** Read the current observability context (undefined when outside any scope) */
export function getObservabilityContext(): ObservabilityAttrs | undefined {
  return store.getStore();
}

// ─── Langfuse Initialization ────────────────────────────────────────────────

let initialized = false;

// Hold a reference to the OTel SDK for clean shutdown
let otelSdk: { shutdown: () => Promise<void> } | null = null;

// Lazily-loaded tracing functions (populated by initLangfuse)
let tracingStartActiveObservation:
  | typeof import('@langfuse/tracing').startActiveObservation
  | null = null;
let tracingPropagateAttributes: typeof import('@langfuse/tracing').propagateAttributes | null =
  null;

/** Check whether Langfuse env vars are present */
export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

/**
 * Initialize Langfuse observability.
 *
 * - Uses dynamic imports so the packages are only loaded when needed
 * - Gracefully degrades: logs a warning and continues if anything fails
 * - Idempotent: calling multiple times is safe
 */
export async function initLangfuse(): Promise<boolean> {
  if (initialized) return true;
  if (!isLangfuseEnabled()) return false;

  try {
    const [otelSdkMod, langfuseOtel, langfuseTracing] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@langfuse/tracing'),
    ]);

    tracingStartActiveObservation = langfuseTracing.startActiveObservation;
    tracingPropagateAttributes = langfuseTracing.propagateAttributes;

    const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? '';
    const secretKey = process.env.LANGFUSE_SECRET_KEY ?? '';
    const spanProcessor = new langfuseOtel.LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
    });

    const sdk = new otelSdkMod.NodeSDK({
      spanProcessors: [spanProcessor],
    });
    sdk.start();
    otelSdk = sdk;

    initialized = true;
    getLog().info(
      { baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com' },
      'langfuse.init_completed'
    );
    return true;
  } catch (error) {
    const err = error as Error;
    getLog().warn({ error: err.message, errorType: err.constructor.name }, 'langfuse.init_failed');
    resetState();
    return false;
  }
}

/** Flush pending spans and shut down the OTel SDK */
export async function shutdownLangfuse(): Promise<void> {
  try {
    if (otelSdk) {
      await otelSdk.shutdown();
      getLog().debug('langfuse.shutdown_completed');
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn({ error: err.message }, 'langfuse.shutdown_failed');
  } finally {
    resetState();
  }
}

function resetState(): void {
  otelSdk = null;
  initialized = false;
  tracingStartActiveObservation = null;
  tracingPropagateAttributes = null;
}

// ─── Query Tracing ──────────────────────────────────────────────────────────

/**
 * Wrap a MessageChunk async generator with Langfuse tracing.
 *
 * Creates a parent "generation" observation with:
 * - Input: the prompt sent to Claude
 * - Output: collected assistant text
 * - Usage: token counts and cost from the result event
 * - Children: one "tool" span per tool call with name and input/output
 *
 * When Langfuse is not initialized, returns the generator unchanged (zero overhead).
 */
export async function* traceQuery(
  prompt: string,
  model: string | undefined,
  generator: AsyncIterable<MessageChunk>
): AsyncGenerator<MessageChunk> {
  if (!initialized || !tracingStartActiveObservation || !tracingPropagateAttributes) {
    yield* generator as AsyncGenerator<MessageChunk>;
    return;
  }

  const startActiveObservation = tracingStartActiveObservation;
  const propagateAttributes = tracingPropagateAttributes;
  const ctx = getObservabilityContext();

  // Collect output data as we stream
  const textParts: string[] = [];
  const toolCalls: { name: string; input?: unknown; output?: string; durationMs?: number }[] = [];
  let usage: TokenUsage | undefined;
  let cost: number | undefined;
  let numTurns: number | undefined;
  let sessionId: string | undefined;
  let traceError: Error | undefined;
  let activeToolCall: { name: string; input?: unknown; startTime: number } | null = null;

  const chunks: MessageChunk[] = [];
  let streamError: Error | undefined;

  // Consume the generator and collect chunks
  try {
    for await (const chunk of generator) {
      chunks.push(chunk);

      if (chunk.type === 'assistant') {
        textParts.push(chunk.content);
      } else if (chunk.type === 'tool') {
        // New tool call starting — close any previous one
        if (activeToolCall) {
          toolCalls.push({
            name: activeToolCall.name,
            input: activeToolCall.input,
            durationMs: Date.now() - activeToolCall.startTime,
          });
        }
        activeToolCall = { name: chunk.toolName, input: chunk.toolInput, startTime: Date.now() };
      } else if (chunk.type === 'tool_result') {
        if (activeToolCall) {
          toolCalls.push({
            name: activeToolCall.name,
            input: activeToolCall.input,
            output:
              typeof chunk.toolOutput === 'string'
                ? chunk.toolOutput.slice(0, 1000)
                : JSON.stringify(chunk.toolOutput).slice(0, 1000),
            durationMs: Date.now() - activeToolCall.startTime,
          });
          activeToolCall = null;
        }
      } else if (chunk.type === 'result') {
        // Close any remaining open tool call
        if (activeToolCall) {
          toolCalls.push({
            name: activeToolCall.name,
            input: activeToolCall.input,
            durationMs: Date.now() - activeToolCall.startTime,
          });
          activeToolCall = null;
        }
        if (chunk.tokens) usage = chunk.tokens;
        if (chunk.cost !== undefined) cost = chunk.cost;
        if (chunk.numTurns !== undefined) numTurns = chunk.numTurns;
        if (chunk.sessionId) sessionId = chunk.sessionId;
      }
    }
  } catch (err) {
    streamError = err as Error;
    traceError = streamError;
  }

  // Create the trace with the collected data
  try {
    await propagateAttributes(
      {
        ...(ctx?.conversationId ? { sessionId: ctx.conversationId } : {}),
        tags: [
          ...(ctx?.platformType ? [ctx.platformType] : []),
          ...(ctx?.workflowName ? [ctx.workflowName] : []),
        ],
      },
      async () => {
        await startActiveObservation(
          'claude-agent-query',
          async obs => {
            // Create child spans for tool calls
            for (const tool of toolCalls) {
              const toolObs = obs.startObservation(
                tool.name,
                {
                  input: tool.input,
                  output: tool.output,
                },
                { asType: 'tool' }
              );
              toolObs.end();
            }

            const usageDetails: Record<string, number> = {};
            if (usage) {
              if (usage.input) usageDetails.input = usage.input;
              if (usage.output) usageDetails.output = usage.output;
              if (usage.total) usageDetails.total = usage.total;
            }

            obs.update({
              input: prompt,
              output: textParts.join(''),
              model: model ?? 'claude-sonnet-4-20250514',
              usageDetails: Object.keys(usageDetails).length > 0 ? usageDetails : undefined,
              metadata: {
                ...(cost !== undefined ? { totalCostUsd: cost } : {}),
                ...(numTurns !== undefined ? { numTurns } : {}),
                ...(sessionId ? { claudeSessionId: sessionId } : {}),
                ...(toolCalls.length > 0 ? { toolCallCount: toolCalls.length } : {}),
                ...(traceError ? { error: traceError.message } : {}),
              },
              level: traceError ? 'ERROR' : undefined,
            });
          },
          { asType: 'generation' }
        );
      }
    );
  } catch (traceErr) {
    getLog().debug({ error: (traceErr as Error).message }, 'langfuse.trace_failed');
  }

  // Yield all collected chunks to the consumer
  for (const chunk of chunks) {
    yield chunk;
  }

  // Re-throw the stream error if one occurred
  if (streamError) {
    throw streamError;
  }
}
