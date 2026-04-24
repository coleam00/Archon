import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  NodeConfig,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseOpencodeConfig } from './config';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const OPENCODE_START_TIMEOUT_MS = 5000;
const OPENCODE_DEFAULT_PORT = 4096;
const OPENCODE_PORT_SEARCH_RANGE = 100; // Try ports 4096-4195

const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403', 'api key'];
const CRASH_PATTERNS = [
  'server disconnected',
  'disposed',
  'econnreset',
  'socket hang up',
  'connection terminated',
  'process terminated',
];

type RetryableErrorClass = 'rate_limit' | 'auth' | 'crash' | 'unknown' | 'aborted';

interface OpencodeClientLike {
  session: {
    create(options?: Record<string, unknown>): Promise<{ data?: { id?: string } }>;
    get(options: Record<string, unknown>): Promise<{ data?: { id?: string } }>;
    promptAsync(options: Record<string, unknown>): Promise<unknown>;
    abort(options: Record<string, unknown>): Promise<unknown>;
    message(
      options: Record<string, unknown>
    ): Promise<{ data?: { info?: Record<string, unknown> } }>;
  };
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{
      stream: AsyncIterable<unknown>;
    }>;
  };
  global: {
    health(): Promise<unknown>;
  };
}

interface EmbeddedRuntime {
  client: OpencodeClientLike;
  server: { url: string; close(): void };
  refCount: number;
  /** Promise that created this runtime - used to prevent race conditions on release */
  creationPromise: Promise<EmbeddedRuntime>;
}

type AgentConfig = NonNullable<NonNullable<NodeConfig['agents']>[string]>;

let embeddedRuntimePromise: Promise<EmbeddedRuntime> | undefined;
let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if a port is available by attempting to create a server on it.
 * Returns true if the port is free, false if it's in use.
 */
async function isPortAvailable(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port starting from the default port.
 * Searches up to OPENCODE_PORT_SEARCH_RANGE ports.
 * In test environment, skips port check and returns default port.
 */
async function findAvailablePort(startPort: number): Promise<number> {
  // Skip port check in test environment to avoid network calls
  if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST === '1') {
    return startPort;
  }

  for (let port = startPort; port < startPort + OPENCODE_PORT_SEARCH_RANGE; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  // If all ports in range are taken, return start port and let the SDK fail with a clear error
  return startPort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message;
    if (isRecord(error.data) && typeof error.data.message === 'string') return error.data.message;
  }
  return String(error);
}

function classifyOpencodeError(error: unknown, aborted: boolean): RetryableErrorClass {
  if (aborted) return 'aborted';

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
  }
  if (isRecord(error)) {
    if (typeof error.name === 'string') parts.push(error.name);
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.statusCode === 'number') parts.push(String(error.statusCode));
    if (isRecord(error.data)) {
      if (typeof error.data.message === 'string') parts.push(error.data.message);
      if (typeof error.data.statusCode === 'number') parts.push(String(error.data.statusCode));
      if (typeof error.data.responseBody === 'string') parts.push(error.data.responseBody);
    }
  }

  const combined = parts.join(' ').toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(pattern => combined.includes(pattern))) return 'rate_limit';
  if (AUTH_PATTERNS.some(pattern => combined.includes(pattern))) return 'auth';
  if (CRASH_PATTERNS.some(pattern => combined.includes(pattern))) return 'crash';
  return 'unknown';
}

function enrichOpencodeError(error: unknown, errorClass: RetryableErrorClass): Error {
  if (errorClass === 'aborted') {
    return new Error('OpenCode query aborted');
  }

  const err = new Error(`OpenCode ${errorClass}: ${errorMessage(error)}`);
  if (error instanceof Error) err.cause = error;
  return err;
}

export function parseModelRef(modelRef: string): { providerID: string; modelID: string } | null {
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1) return null;

  const providerID = modelRef.slice(0, slashIndex).trim();
  const modelID = modelRef.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) return null;

  return { providerID, modelID };
}

let warnedMultipleAgents = false;

function selectPrimaryAgent(agents: Record<string, AgentConfig>): string | undefined {
  const agentNames = Object.keys(agents);
  if (agentNames.length > 1 && !warnedMultipleAgents) {
    warnedMultipleAgents = true;
    getLog().warn(
      { agents: agentNames, selected: agentNames[0] },
      'opencode.multiple_agents_configured_using_first'
    );
  }
  return agentNames[0];
}

function buildToolsPermissionsMap(
  allowed?: string[],
  denied?: string[]
): Record<string, boolean> | undefined {
  const toolsPermissions: Record<string, boolean> = {};

  for (const tool of allowed ?? []) {
    toolsPermissions[tool] = true;
  }

  for (const tool of denied ?? []) {
    toolsPermissions[tool] = false;
  }

  return Object.keys(toolsPermissions).length > 0 ? toolsPermissions : undefined;
}

function adaptAgentConfigForOpencode(nodeConfig?: NodeConfig):
  | {
      agent?: string;
      model?: { providerID: string; modelID: string };
      tools?: Record<string, boolean>;
    }
  | undefined {
  const agents = nodeConfig?.agents;
  if (!agents) return undefined;

  const agent = selectPrimaryAgent(agents);
  if (!agent) return undefined;

  const primaryAgent = agents[agent];
  const adaptedConfig: {
    agent?: string;
    model?: { providerID: string; modelID: string };
    tools?: Record<string, boolean>;
  } = { agent };

  if (primaryAgent?.model) {
    const parsedModel = parseModelRef(primaryAgent.model);
    if (!parsedModel) {
      throw new Error(
        `Invalid OpenCode agent model ref for '${agent}': '${primaryAgent.model}'. Expected format '<provider>/<model>' (for example 'anthropic/claude-3-5-sonnet').`
      );
    }
    adaptedConfig.model = parsedModel;
  }

  const tools = buildToolsPermissionsMap(primaryAgent?.tools, primaryAgent?.disallowedTools);
  if (tools) {
    adaptedConfig.tools = tools;
  }

  // OpenCode supports per-call agent/model/tool overrides, but not prompt/description injection.
  return adaptedConfig;
}

function normalizeTokens(info: Record<string, unknown> | undefined): TokenUsage | undefined {
  const tokens = isRecord(info?.tokens) ? info.tokens : undefined;
  if (!tokens) return undefined;

  const input = typeof tokens.input === 'number' ? tokens.input : 0;
  const output = typeof tokens.output === 'number' ? tokens.output : 0;
  const reasoning = typeof tokens.reasoning === 'number' ? tokens.reasoning : 0;
  const total = input + output + reasoning;

  return {
    input,
    output,
    ...(total > 0 ? { total } : {}),
    ...(typeof info?.cost === 'number' ? { cost: info.cost } : {}),
  };
}

/**
 * Try to connect to an existing OpenCode server at the default port.
 * Returns the client if successful, null if connection fails.
 */
async function tryExistingServer(): Promise<OpencodeClientLike | null> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const client = createOpencodeClient({
    baseUrl: `http://localhost:${OPENCODE_DEFAULT_PORT}`,
  }) as unknown as OpencodeClientLike;

  try {
    // Use global.health() for a stateless health check, with 2s timeout
    const healthPromise = client.global.health();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('health_check_timeout'));
      }, 2000);
    });
    await Promise.race([healthPromise, timeoutPromise]);
    getLog().info({ port: OPENCODE_DEFAULT_PORT }, 'opencode.existing_server_found');
    return client;
  } catch (error) {
    const isConnectionRefused =
      error instanceof Error &&
      (error.message.includes('Unable to connect') ||
        error.message.includes('ConnectionRefused') ||
        error.message.includes('ECONNREFUSED') ||
        error.message === 'health_check_timeout');

    if (isConnectionRefused) {
      getLog().debug({ port: OPENCODE_DEFAULT_PORT }, 'opencode.no_existing_server');
      return null;
    }

    // Other errors (auth, etc) - let them propagate
    throw error;
  }
}

async function acquireEmbeddedRuntime(signal?: AbortSignal): Promise<EmbeddedRuntime> {
  if (!embeddedRuntimePromise) {
    // Use a deferred pattern with both resolve and reject to ensure all startup
    // errors propagate to callers instead of leaving them hanging.
    let resolveRuntime: ((runtime: EmbeddedRuntime) => void) | undefined;
    let rejectRuntime: ((error: unknown) => void) | undefined;

    const promise = new Promise<EmbeddedRuntime>((resolve, reject) => {
      resolveRuntime = resolve;
      rejectRuntime = reject;
    });
    embeddedRuntimePromise = promise;

    // Build the runtime, wiring both success and failure paths
    (async (): Promise<void> => {
      try {
        // First, try to connect to an existing server
        const existingClient = await tryExistingServer();
        if (existingClient) {
          resolveRuntime?.({
            client: existingClient,
            server: {
              url: `http://localhost:${OPENCODE_DEFAULT_PORT}`,
              close: (): void => {
                /* external server, don't close */
              },
            },
            refCount: 0,
            creationPromise: promise,
          });
          return;
        }

        // No existing server - spawn our own
        const { createOpencode } = await import('@opencode-ai/sdk');

        // Find an available port to avoid conflicts
        const port = await findAvailablePort(OPENCODE_DEFAULT_PORT);
        getLog().info(
          { defaultPort: OPENCODE_DEFAULT_PORT, selectedPort: port },
          'opencode.port_selected'
        );

        const runtime = await createOpencode({
          port,
          signal,
          timeout: OPENCODE_START_TIMEOUT_MS,
        });
        resolveRuntime?.({
          client: runtime.client as unknown as OpencodeClientLike,
          server: runtime.server,
          refCount: 0,
          creationPromise: promise,
        });
      } catch (error) {
        embeddedRuntimePromise = undefined;
        rejectRuntime?.(error);
      }
    })();
  }

  const runtime = await embeddedRuntimePromise;
  runtime.refCount += 1;
  return runtime;
}

function releaseEmbeddedRuntime(runtime: EmbeddedRuntime): void {
  runtime.refCount = Math.max(0, runtime.refCount - 1);
  if (runtime.refCount > 0) return;

  // Always close the server we own. External servers have a no-op close().
  // This decouples resource cleanup from cache identity checks.
  try {
    runtime.server.close();
  } finally {
    // Only clear the cached promise if this runtime was created by the current promise.
    // This prevents a race condition where a newer runtime replaces the cached promise
    // while an older release call is still in flight.
    if (embeddedRuntimePromise === runtime.creationPromise) {
      embeddedRuntimePromise = undefined;
    }
  }
}

async function createExternalClient(baseUrl: string): Promise<OpencodeClientLike> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  return createOpencodeClient({ baseUrl }) as unknown as OpencodeClientLike;
}

async function resolveSessionId(
  client: OpencodeClientLike,
  cwd: string,
  resumeSessionId: string | undefined
): Promise<{ sessionId: string; resumed: boolean }> {
  if (resumeSessionId) {
    try {
      const existing = await client.session.get({
        path: { id: resumeSessionId },
        query: { directory: cwd },
      });
      const sessionId = existing.data?.id;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        return { sessionId, resumed: true };
      }
    } catch {
      // Fall through to fresh session creation and surface a warning upstream.
    }
  }

  const created = await client.session.create({ query: { directory: cwd } });
  const sessionId = created.data?.id;
  if (!sessionId) {
    throw new Error('OpenCode failed to create a session');
  }

  return { sessionId, resumed: false };
}

async function readStructuredOutput(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  messageId: string | undefined
): Promise<unknown> {
  if (!messageId) return undefined;

  try {
    const response = await client.session.message({
      path: { id: sessionId, messageID: messageId },
      query: { directory: cwd },
    });
    const info = response.data?.info;
    if (isRecord(info) && 'structured_output' in info) {
      return info.structured_output;
    }
  } catch (error) {
    getLog().debug(
      { err: error, sessionId, messageId },
      'opencode.structured_output_lookup_failed'
    );
  }

  return undefined;
}

async function* streamOpencodeSession(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  prompt: string,
  model: { providerID: string; modelID: string },
  requestOptions: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  const events = await client.event.subscribe({ query: { directory: cwd } });
  const streamController = new AbortController();
  const seenToolCalls = new Set<string>();
  const completedToolCalls = new Set<string>();
  let latestAssistantInfo: Record<string, unknown> | undefined;
  let lastAssistantMessageId: string | undefined;
  let aborted = requestOptions?.abortSignal?.aborted === true;
  let resultYielded = false;

  const abortHandler = (): void => {
    aborted = true;
    void client.session
      .abort({ path: { id: sessionId }, query: { directory: cwd } })
      .catch((error): void => {
        getLog().debug({ err: error, sessionId }, 'opencode.session_abort_failed');
      });
    streamController.abort();
  };

  requestOptions?.abortSignal?.addEventListener('abort', abortHandler, {
    once: true,
  });

  try {
    const adaptedAgentConfig = adaptAgentConfigForOpencode(requestOptions?.nodeConfig);
    const promptBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
      model: adaptedAgentConfig?.model ?? model,
      ...(adaptedAgentConfig?.agent ? { agent: adaptedAgentConfig.agent } : {}),
      ...(adaptedAgentConfig?.tools ? { tools: adaptedAgentConfig.tools } : {}),
      ...(requestOptions?.systemPrompt ? { system: requestOptions.systemPrompt } : {}),
    };

    if (requestOptions?.outputFormat?.type === 'json_schema') {
      promptBody.format = {
        type: 'json_schema',
        schema: requestOptions.outputFormat.schema,
      };
    }

    await client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: cwd },
      body: promptBody,
    });

    for await (const rawEvent of abortableStream(events.stream, streamController.signal)) {
      const event = rawEvent as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const properties = isRecord(event.properties) ? event.properties : {};

      if (event.type === 'message.updated') {
        const info = isRecord(properties.info) ? properties.info : undefined;
        if (info?.role === 'assistant' && info.sessionID === sessionId) {
          latestAssistantInfo = info;
          if (typeof info.id === 'string') {
            lastAssistantMessageId = info.id;
          }
        }
        continue;
      }

      if (event.type === 'message.part.updated') {
        const part = isRecord(properties.part) ? properties.part : undefined;
        if (!part || part?.sessionID !== sessionId || typeof part.type !== 'string') {
          continue;
        }

        if (part.type === 'text') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            yield { type: 'assistant', content: text };
          }
          continue;
        }

        if (part.type === 'reasoning') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            yield { type: 'thinking', content: text };
          }
          continue;
        }

        if (part.type === 'tool') {
          const callId = typeof part.callID === 'string' ? part.callID : undefined;
          const toolName = typeof part.tool === 'string' ? part.tool : 'unknown';
          const state = isRecord(part.state) ? part.state : undefined;
          const toolInput = isRecord(state?.input) ? state.input : undefined;
          const status = typeof state?.status === 'string' ? state.status : undefined;

          if (callId && !seenToolCalls.has(callId)) {
            seenToolCalls.add(callId);
            yield {
              type: 'tool',
              toolName,
              ...(toolInput ? { toolInput } : {}),
              ...(callId ? { toolCallId: callId } : {}),
            };
          }

          if (callId && !completedToolCalls.has(callId)) {
            if (status === 'completed') {
              completedToolCalls.add(callId);
              yield {
                type: 'tool_result',
                toolName,
                toolOutput: typeof state?.output === 'string' ? state.output : '',
                ...(callId ? { toolCallId: callId } : {}),
              };
            } else if (status === 'error') {
              completedToolCalls.add(callId);
              yield {
                type: 'tool_result',
                toolName,
                toolOutput: typeof state?.error === 'string' ? state.error : 'Tool failed',
                ...(callId ? { toolCallId: callId } : {}),
              };
            }
          }
        }
        continue;
      }

      if (event.type === 'session.error') {
        const eventSessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        if (eventSessionId && eventSessionId !== sessionId) continue;

        const rawError = isRecord(properties.error) ? properties.error : properties;
        const err = new Error(errorMessage(rawError));
        err.cause = rawError;
        throw err;
      }

      if (event.type === 'session.idle') {
        if (properties.sessionID !== sessionId) continue;

        const structuredOutput = await readStructuredOutput(
          client,
          cwd,
          sessionId,
          lastAssistantMessageId
        );
        const tokens = normalizeTokens(latestAssistantInfo);

        yield {
          type: 'result',
          sessionId,
          ...(tokens ? { tokens } : {}),
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
          ...(typeof latestAssistantInfo?.cost === 'number'
            ? { cost: latestAssistantInfo.cost }
            : {}),
          ...(typeof latestAssistantInfo?.finish === 'string'
            ? { stopReason: latestAssistantInfo.finish }
            : {}),
          ...(latestAssistantInfo
            ? {
                modelUsage: {
                  providerID: latestAssistantInfo.providerID,
                  modelID: latestAssistantInfo.modelID,
                  reasoning: isRecord(latestAssistantInfo.tokens)
                    ? latestAssistantInfo.tokens.reasoning
                    : undefined,
                  cache: isRecord(latestAssistantInfo.tokens)
                    ? latestAssistantInfo.tokens.cache
                    : undefined,
                },
              }
            : {}),
        };
        resultYielded = true;
        return;
      }
    }

    // If stream ended without session.idle, yield a terminal result chunk
    // to ensure downstream DAG executors don't hang waiting for a result.
    if (!resultYielded && !aborted) {
      yield { type: 'result', sessionId };
    }

    if (aborted) {
      throw new Error('OpenCode query aborted');
    }
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    streamController.abort();
  }
}

async function* abortableStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal
): AsyncGenerator<unknown, void, unknown> {
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    if (signal.aborted) {
      // Clean up the iterator's resources before returning
      await iterator.return?.().catch(() => undefined);
      return;
    }

    const nextPromise = iterator.next();
    const result = await Promise.race([
      nextPromise,
      new Promise<IteratorResult<unknown>>(resolve => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve({ done: true, value: undefined });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void nextPromise.finally((): void => {
          signal.removeEventListener('abort', onAbort);
        });
      }),
    ]);

    if (result.done) {
      await iterator.return?.().catch(() => undefined);
      return;
    }
    yield result.value;
  }
}

export class OpencodeProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = parseOpencodeConfig(requestOptions?.assistantConfig ?? {});
    const modelRef = requestOptions?.model ?? assistantConfig.model;
    const parsedModelOrNull = modelRef ? parseModelRef(modelRef) : undefined;

    if (modelRef && !parsedModelOrNull) {
      throw new Error(
        `Invalid OpenCode model ref: '${modelRef}'. Expected format '<provider>/<model>' (for example 'anthropic/claude-3-5-sonnet').`
      );
    }

    if (!parsedModelOrNull) {
      throw new Error(
        'OpenCode requires a model to be specified. ' +
          'Set model in assistants config (e.g., model: anthropic/claude-3-5-sonnet).'
      );
    }

    const parsedModel = parsedModelOrNull;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('OpenCode query aborted');
      }

      const runtime = assistantConfig.baseUrl
        ? {
            client: await createExternalClient(assistantConfig.baseUrl),
            release: (): void => {
              /* external client, no cleanup needed */
            },
          }
        : await (async (): Promise<{ client: OpencodeClientLike; release: () => void }> => {
            const embedded = await acquireEmbeddedRuntime(requestOptions?.abortSignal);
            return {
              client: embedded.client,
              release: (): void => {
                releaseEmbeddedRuntime(embedded);
              },
            };
          })();

      try {
        const { sessionId, resumed } = await resolveSessionId(runtime.client, cwd, resumeSessionId);
        if (resumeSessionId && !resumed) {
          yield {
            type: 'system',
            content: '⚠️ Could not resume OpenCode session. Starting fresh conversation.',
          };
        }

        yield* streamOpencodeSession(
          runtime.client,
          cwd,
          sessionId,
          prompt,
          parsedModel,
          requestOptions
        );
        return;
      } catch (error) {
        const errorClass = classifyOpencodeError(
          error,
          requestOptions?.abortSignal?.aborted === true
        );
        const enrichedError = enrichOpencodeError(error, errorClass);
        const shouldRetry = errorClass === 'rate_limit' || errorClass === 'crash';

        getLog().error(
          {
            err: error,
            errorClass,
            attempt,
            maxRetries: MAX_RETRIES,
          },
          'opencode.query_failed'
        );

        if (!shouldRetry || attempt >= MAX_RETRIES - 1) {
          throw enrichedError;
        }

        const delayMs = this.retryBaseDelayMs * 2 ** attempt;
        getLog().info({ attempt, delayMs, errorClass }, 'opencode.retrying_query');
        await delay(delayMs);
        lastError = enrichedError;
      } finally {
        runtime.release();
      }
    }

    throw lastError ?? new Error('OpenCode query failed after retries');
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }
}

/**
 * Reset the embedded runtime state. For testing only.
 * This clears the cached runtime promise so tests can start fresh.
 */
export function resetEmbeddedRuntime(): void {
  embeddedRuntimePromise = undefined;
}
