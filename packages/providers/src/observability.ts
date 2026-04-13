/**
 * Observability module — optional Langfuse integration via OpenTelemetry.
 *
 * When LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set, initializes:
 * - OTel NodeSDK with LangfuseSpanProcessor
 * - Auto-instrumentation for @anthropic-ai/claude-agent-sdk
 *
 * When not configured, all exports are safe no-ops with zero overhead.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createLogger } from '@archon/paths';

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

type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;
let instrumentedQueryFn: QueryFn | null = null;

// Hold a reference to the OTel SDK for clean shutdown
let otelSdk: { shutdown: () => Promise<void> } | null = null;

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
    const [otelSdkMod, langfuseOtel, claudeInstr, claudeSdk] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@arizeai/openinference-instrumentation-claude-agent-sdk'),
      import('@anthropic-ai/claude-agent-sdk'),
    ]);

    // Create a mutable copy of the SDK module for instrumentation.
    // Type assertion needed: the instrumentation expects its own peer dep type,
    // which may differ from our pinned SDK version at the type level.
    const sdkCopy = { ...claudeSdk };
    const instrumentation = new claudeInstr.ClaudeAgentSDKInstrumentation();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridging SDK version types for auto-instrumentation
    instrumentation.manuallyInstrument(sdkCopy as any);
    instrumentedQueryFn = sdkCopy.query;

    const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? '';
    const secretKey = process.env.LANGFUSE_SECRET_KEY ?? '';
    const spanProcessor = new langfuseOtel.LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
      // Export all spans — the default filter (isDefaultExportSpan) may not
      // recognize the Arize Claude Agent SDK instrumentation spans.
      shouldExportSpan: (): boolean => true,
    });

    const sdk = new otelSdkMod.NodeSDK({
      spanProcessors: [spanProcessor],
      instrumentations: [instrumentation],
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
    // Reset partial state so getQuery() falls back to the original SDK
    otelSdk = null;
    initialized = false;
    instrumentedQueryFn = null;
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
    otelSdk = null;
    initialized = false;
    instrumentedQueryFn = null;
  }
}

// ─── Instrumented Query ─────────────────────────────────────────────────────

/**
 * Return the instrumented `query` function when Langfuse is active,
 * otherwise fall back to the original SDK export.
 */
export function getQuery(): QueryFn {
  if (instrumentedQueryFn) return instrumentedQueryFn;

  // Fallback: return the original, un-instrumented query
  // This import is resolved at module load time by Bun (static reference)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { query } = require('@anthropic-ai/claude-agent-sdk') as { query: QueryFn };
  return query;
}
