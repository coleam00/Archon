/**
 * Codex provider: one Codex turn per `sendQuery`, driven over the `codex app-server`
 * JSON-RPC protocol so a failed turn reports a typed `codexErrorInfo`.
 */
import type {
  IAgentProvider,
  SendQueryOptions,
  NodeConfig,
  MessageChunk,
  ProviderEvent,
  ProviderWarning,
  ResultChunk,
  TokenUsage,
  ProviderCapabilities,
  CodexProviderDefaults,
} from '../types';
import { truncateToolOutput, type ProviderFailureClass } from '@archon/provider-contract';
import { failureClassOfThrown, failureResult } from '../shared/failure';
import { clampEffort } from '@archon/paths/effort';
import { CODEX_EFFORTS, parseCodexConfig } from './config';
import { CODEX_CAPABILITIES } from './capabilities';
import { resolveCodexBinary } from './binary-resolver';
import { BUNDLED_VERSION, createLogger } from '@archon/paths';
import { loadMcpConfig } from '../mcp/config';
import {
  hasOpenAdditionalProperties,
  normalizeJsonSchemaForOpenAiStrict,
} from '../shared/structured-output';
import { closeOpenToolCalls } from '../shared/tool-calls';
import {
  AppServerConnection,
  ConnectionClosedError,
  JsonRpcError,
  settlesWithin,
  type ParamsOf,
  type Spawner,
} from './app-server';
import { classifyTurnError } from './turn-error';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown';
import type { Turn } from './protocol/v2/Turn';
import type { TurnError } from './protocol/v2/TurnError';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

type CodexConfig = Record<string, JsonValue>;

/**
 * How long the app-server gets to answer a cancel's interrupt, then to exit after stdin
 * closes, then again after SIGTERM.
 */
const SHUTDOWN_GRACE_MS = 3000;

/**
 * Resolve Codex's reasoning effort from Archon's inputs.
 *
 * Precedence: `nodeConfig.effort` > `assistants.codex.modelReasoningEffort`
 * from config.yaml — mirroring Copilot's `resolveCopilotReasoning`, so a workflow's
 * declared depth beats the install default on both providers alike.
 *
 * Codex accepts every rung on Archon's ladder. A value that is not on the
 * ladder at all falls back to the config default rather than being invented;
 * the workflow loader rejects such values at parse time, so this only guards
 * programmatic callers.
 */
function resolveModelReasoningEffort(
  nodeConfig: NodeConfig | undefined,
  configured: CodexProviderDefaults['modelReasoningEffort']
): CodexProviderDefaults['modelReasoningEffort'] {
  const declared = nodeConfig?.effort;
  if (declared === undefined) return configured;

  const clamped = clampEffort(declared, CODEX_EFFORTS);
  if (clamped === undefined) {
    getLog().warn({ effort: declared }, 'codex.effort_unrecognized');
    return configured;
  }
  if (clamped !== declared) {
    getLog().debug({ declared, applied: clamped }, 'codex.effort_clamped');
  }
  return clamped;
}

/** The process env with the request env on top: managed project env wins on collisions. */
function buildCodexEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...requestEnv };
}

const CODEX_MCP_PASSTHROUGH_KEYS = [
  'command',
  'args',
  'env',
  'url',
  'enabled',
  'required',
  'startup_timeout_sec',
  'startup_timeout_ms',
  'tool_timeout_sec',
  'enabled_tools',
  'disabled_tools',
  'supports_parallel_tool_calls',
  'cwd',
  'env_vars',
  'experimental_environment',
  'http_headers',
  'env_http_headers',
  'oauth_resource',
  'scopes',
  'bearer_token_env_var',
  'default_tools_approval_mode',
  'tools',
] as const;

function toJsonValue(value: unknown): JsonValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const result: CodexConfig = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const converted = toJsonValue(nestedValue);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return undefined;
}

function convertMcpServerConfigForCodex(serverConfig: Record<string, unknown>): CodexConfig {
  const result: CodexConfig = {};
  for (const key of CODEX_MCP_PASSTHROUGH_KEYS) {
    const converted = key in serverConfig ? toJsonValue(serverConfig[key]) : undefined;
    if (converted !== undefined) result[key] = converted;
  }
  // Archon's MCP JSON format uses `headers`; Codex config uses `http_headers`.
  if ('headers' in serverConfig && !('http_headers' in result)) {
    const converted = toJsonValue(serverConfig.headers);
    if (converted !== undefined) result.http_headers = converted;
  }
  return result;
}

function buildCodexMcpServers(servers: Record<string, unknown>): CodexConfig | undefined {
  const mcpServers: CodexConfig = {};
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (typeof serverConfig !== 'object' || serverConfig === null || Array.isArray(serverConfig)) {
      getLog().warn(
        { serverName, valueType: typeof serverConfig },
        'codex.mcp_server_config_not_object'
      );
      continue;
    }
    const converted = convertMcpServerConfigForCodex(serverConfig as Record<string, unknown>);
    if (Object.keys(converted).length > 0) mcpServers[serverName] = converted;
  }
  return Object.keys(mcpServers).length > 0 ? mcpServers : undefined;
}

function isWorkflowNode(requestOptions?: SendQueryOptions): boolean {
  const nodeId = requestOptions?.nodeConfig?.nodeId;
  return typeof nodeId === 'string' && nodeId.trim().length > 0;
}

/**
 * The config overrides a thread starts with. Codex merges them over the user's own
 * config.toml; it never replaces it.
 */
function buildThreadConfig(
  codexConfig: CodexProviderDefaults,
  mcpServers: CodexConfig | undefined,
  workflowNode: boolean
): CodexConfig {
  const config: CodexConfig = {
    sandbox_workspace_write: {
      network_access: true,
      ...(codexConfig.additionalDirectories?.length
        ? { writable_roots: codexConfig.additionalDirectories }
        : {}),
    },
  };
  if (codexConfig.webSearchMode) config.web_search = codexConfig.webSearchMode;
  if (mcpServers) config.mcp_servers = mcpServers;
  // Workflow nodes invoke skills explicitly (`$skill-name`); the automatic catalog stays
  // off so undeclared skills are not advertised. Direct chat keeps the user's setting.
  // An older Codex ignores the key with a config warning rather than failing.
  if (workflowNode) config.skills = { include_instructions: false };
  return config;
}

// Maps slugs that ChatGPT-plan accounts now reject (previously shipped as Archon
// suggestions/defaults) to a current, plan-accepted slug to suggest instead.
const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.6-sol',
  'gpt-5.2-codex': 'gpt-5.6-sol',
  'gpt-5.2': 'gpt-5.6-sol',
};

// A display-only heuristic over vendor text: it decides whether the operator sees
// model-access advice, never the failure class.
function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') || m.includes('not found') || m.includes('access denied');
  return hasModel && hasAvailabilitySignal;
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  const suggested = normalizedModel ? CODEX_MODEL_FALLBACKS[normalizedModel] : undefined;

  const fixLine = suggested
    ? `To fix: update your model in ~/.archon/config.yaml:\n  assistants:\n    codex:\n      model: ${suggested}`
    : 'To fix: update your model in ~/.archon/config.yaml to one your account can access.';

  const workflowLine = suggested
    ? `Or set it per-workflow with \`model: ${suggested}\` in workflow YAML.`
    : 'Or set it per-workflow with a valid `model:` in workflow YAML.';

  return `❌ Model "${selectedModel}" is not available for your account.\n\n${fixLine}\n\n${workflowLine}`;
}

/** The output schema a turn sends, and whether its final message is parsed as JSON. */
function buildOutputSchema(requestOptions?: SendQueryOptions): {
  outputSchema: JsonValue | undefined;
  hasOutputFormat: boolean;
} {
  // Preserve the original precedence: an explicit `outputFormat` wins over
  // `nodeConfig.output_format` even when its `.schema` is undefined. Note the
  // resulting asymmetry: if `outputFormat` is set but `.schema` is undefined,
  // no schema is sent yet `hasOutputFormat` is still true — the final message
  // is still JSON.parsed.
  const rawSchema =
    requestOptions?.outputFormat !== undefined
      ? requestOptions.outputFormat.schema
      : requestOptions?.nodeConfig?.output_format;
  const hasOutputFormat = !!(
    requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
  );
  if (rawSchema === undefined) return { outputSchema: undefined, hasOutputFormat };
  // OpenAI Structured Outputs strict-mode requires additionalProperties:false
  // on every object schema (HTTP 400 invalid_json_schema otherwise). Workflow
  // authors write portable output_format schemas, so normalize here before
  // handing the schema to Codex. See issue #1843.
  if (hasOpenAdditionalProperties(rawSchema)) {
    // The normalizer is about to rewrite an open-record `additionalProperties`
    // (e.g. `{ type: 'string' }` or `true`) to `false`. OpenAI would 400 the
    // open form anyway, but the author never declared a closed object — warn
    // so the silent narrowing is visible rather than a surprise at runtime.
    getLog().warn({ schema: rawSchema }, 'codex.output_format_open_record_closed');
  }
  return {
    outputSchema: toJsonValue(normalizeJsonSchemaForOpenAiStrict(rawSchema)),
    hasOutputFormat,
  };
}

/**
 * Fold the request/node-level systemPrompt into the user prompt, separated by the
 * same `---` delimiter augmentPromptForJsonSchema uses. See issue #1837.
 *
 * Precedence mirrors the Pi provider: request-level systemPrompt wins over
 * node-level. Only string / string[] are supported; SystemPromptPreset
 * objects are Claude-specific and dropped with a WARN (the orchestrator
 * already sends non-Claude providers a plain string).
 *
 * The prepend intentionally repeats on EVERY turn, including resumed
 * threads: the provider cannot know whether a resumed session's earlier
 * turns carried the instructions. This matches Claude, which receives the
 * systemPrompt on every query.
 */
function buildEffectivePrompt(prompt: string, requestOptions?: SendQueryOptions): string {
  const raw = requestOptions?.systemPrompt ?? requestOptions?.nodeConfig?.systemPrompt;
  if (raw === undefined) {
    return prompt;
  }
  let systemText: string | undefined;
  if (typeof raw === 'string') {
    systemText = raw;
  } else if (Array.isArray(raw)) {
    systemText = raw.join('\n\n');
  }
  if (systemText === undefined) {
    getLog().warn({ systemPromptType: typeof raw }, 'codex.system_prompt_dropped_preset');
    return prompt;
  }
  if (systemText.trim() === '') {
    return prompt;
  }
  return `${systemText}\n\n---\n\n${prompt}`;
}

// ─── Stream Normalizer ───────────────────────────────────────────────────

type ToolCallEvent = Extract<ProviderEvent, { type: 'tool_call' }>;
type ToolCallUpdateEvent = Extract<ProviderEvent, { type: 'tool_call_update' }>;
type ToolItem = Extract<
  ThreadItem,
  { type: 'commandExecution' | 'webSearch' | 'mcpToolCall' | 'fileChange' }
>;

function isToolItem(item: ThreadItem): item is ToolItem {
  return (
    item.type === 'commandExecution' ||
    item.type === 'webSearch' ||
    item.type === 'mcpToolCall' ||
    item.type === 'fileChange'
  );
}

/**
 * The `tool_call` for an item that runs a tool. `title` is what the operator reads (the
 * command, the query, `server/tool`); `name` is the kind of tool.
 */
function toolCallOf(item: ToolItem): ToolCallEvent {
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'command_execution',
        title: item.command,
        rawInput: { command: item.command },
      };
    case 'webSearch':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'web_search',
        title: item.query,
        rawInput: { query: item.query },
      };
    case 'mcpToolCall': {
      const call: ToolCallEvent = {
        type: 'tool_call',
        toolCallId: item.id,
        name: item.tool,
        title: `${item.server}/${item.tool}`,
      };
      if (typeof item.arguments === 'object' && item.arguments !== null) {
        call.rawInput = item.arguments as Record<string, unknown>;
      }
      return call;
    }
    case 'fileChange':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'file_change',
        rawInput: { changes: item.changes },
      };
  }
}

/** A tool item that ran and failed, or that Codex refused to run. */
function itemFailed(item: ToolItem): boolean {
  if (item.type === 'webSearch') return false;
  if (item.status === 'failed' || item.status === 'declined') return true;
  return item.type === 'commandExecution' && item.exitCode !== null && item.exitCode !== 0;
}

/** The `tool_call_update` that closes a completed tool item. */
function toolCallUpdateOf(item: ToolItem): ToolCallUpdateEvent {
  const update: ToolCallUpdateEvent = {
    type: 'tool_call_update',
    toolCallId: item.id,
    status: itemFailed(item) ? 'failed' : 'completed',
  };
  switch (item.type) {
    case 'commandExecution':
      if (item.exitCode !== null) update.exitCode = item.exitCode;
      return { ...update, ...truncateToolOutput(item.aggregatedOutput ?? '') };
    case 'mcpToolCall':
      if (item.status === 'failed') {
        return { ...update, ...truncateToolOutput(item.error?.message ?? 'MCP tool failed') };
      }
      return {
        ...update,
        ...truncateToolOutput(item.result?.content ? JSON.stringify(item.result.content) : ''),
      };
    case 'webSearch':
    case 'fileChange':
      return update;
  }
}

function tokenUsageOf(last: TokenUsageBreakdown): TokenUsage {
  return {
    input: last.inputTokens,
    output: last.outputTokens,
    cacheRead: last.cachedInputTokens,
    cacheWrite: last.cacheWriteInputTokens,
  };
}

/** A string at `value[key]`, or undefined: responses are read narrowly, not trusted whole. */
function idAt(value: unknown, key: 'thread' | 'turn'): string | undefined {
  const nested =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const id =
    typeof nested === 'object' && nested !== null ? (nested as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

interface TurnRequest {
  connection: AppServerConnection;
  apiKey: string | undefined;
  cwd: string;
  resumeSessionId: string | undefined;
  threadParams: Pick<ParamsOf<'thread/start'>, 'sandbox' | 'approvalPolicy' | 'model' | 'config'>;
  turnParams: Omit<ParamsOf<'turn/start'>, 'threadId'>;
  hasOutputFormat: boolean;
  model: string | undefined;
  /** Receives the thread id as soon as it exists, so a failure can still carry it. */
  onThread: (threadId: string) => void;
  /** Receives the turn id as soon as it exists, so cancel can interrupt it. */
  onTurn: (turnId: string) => void;
}

/**
 * Runs one turn and yields its events, then its one result. A JSON-RPC error or the
 * process ending before `turn/completed` is thrown for `sendQuery` to classify.
 */
async function* streamTurn(request: TurnRequest): AsyncGenerator<MessageChunk> {
  const { connection } = request;
  await connection.request('initialize', {
    clientInfo: { name: 'archon', title: 'Archon', version: BUNDLED_VERSION },
    capabilities: null,
  });
  connection.notify('initialized');
  if (request.apiKey) {
    // The key stays in this process's memory: the app-server was started with the
    // ephemeral credential store, so nothing reaches the user's CODEX_HOME.
    await connection.request('account/login/start', { type: 'apiKey', apiKey: request.apiKey });
  }

  const threadResponse = request.resumeSessionId
    ? await connection.request('thread/resume', {
        threadId: request.resumeSessionId,
        cwd: request.cwd,
        ...request.threadParams,
        excludeTurns: true,
      })
    : await connection.request('thread/start', { cwd: request.cwd, ...request.threadParams });
  const threadId = idAt(threadResponse, 'thread');
  if (!threadId) throw new Error('Codex app-server returned a thread without an id');
  request.onThread(threadId);
  getLog().debug({ threadId, resumed: !!request.resumeSessionId }, 'codex.thread_ready');

  const turnResponse = await connection.request('turn/start', {
    threadId,
    ...request.turnParams,
  });
  const turnId = idAt(turnResponse, 'turn');
  if (!turnId) throw new Error('Codex app-server returned a turn without an id');
  request.onTurn(turnId);

  const startedToolIds = new Set<string>();
  const errors: string[] = [];
  let lastAgentMessage = '';
  let usage: TokenUsage | undefined;
  let rateLimits: RateLimitSnapshot | undefined;

  for await (const notification of connection.notifications()) {
    switch (notification.method) {
      case 'account/rateLimits/updated':
        rateLimits = notification.params.rateLimits;
        break;

      case 'thread/tokenUsage/updated':
        // A resumed thread first replays the previous turn's usage under its own turn id.
        if (notification.params.turnId === turnId) {
          usage = tokenUsageOf(notification.params.tokenUsage.last);
        }
        break;

      case 'error':
        // `willRetry` errors are Codex reconnecting on its own; the turn's outcome is
        // decided by `turn/completed`. They are kept as evidence for a turn that never
        // completes.
        getLog().debug(
          {
            willRetry: notification.params.willRetry,
            codexErrorInfo: notification.params.error.codexErrorInfo,
          },
          'codex.turn_error_notification'
        );
        errors.push(notification.params.error.message);
        break;

      case 'item/started': {
        const { item } = notification.params;
        if (isToolItem(item) && !startedToolIds.has(item.id)) {
          startedToolIds.add(item.id);
          yield toolCallOf(item);
        }
        break;
      }

      case 'item/completed': {
        const { item } = notification.params;
        getLog().debug({ itemType: item.type, itemId: item.id }, 'item_completed');
        if (isToolItem(item)) {
          // A file change is reported only once it is applied: open the call here so its
          // update always has one.
          if (!startedToolIds.has(item.id)) {
            startedToolIds.add(item.id);
            yield toolCallOf(item);
          }
          if (item.type === 'mcpToolCall' && item.status === 'failed') {
            getLog().warn(
              { server: item.server, tool: item.tool, error: item.error, itemId: item.id },
              'mcp_tool_call_failed'
            );
          }
          yield toolCallUpdateOf(item);
        } else if (item.type === 'agentMessage' && item.text) {
          // A turn can hold several messages (preamble + answer); the last is the
          // structured-output candidate.
          lastAgentMessage = item.text;
          yield { type: 'agent_message_chunk', text: item.text };
        } else if (item.type === 'reasoning') {
          const text = item.summary.join('\n\n');
          if (text) yield { type: 'agent_thought_chunk', text };
        }
        break;
      }

      case 'turn/completed': {
        const { turn } = notification.params;
        if (turn.id !== turnId) break;
        yield* completeTurn(turn.status, turn.error, request, {
          threadId,
          usage,
          rateLimits,
          lastAgentMessage,
        });
        return;
      }

      default:
        break;
    }
  }
  throw connection.closedError(await connection.ended, errors);
}

function* completeTurn(
  status: Turn['status'],
  error: TurnError | null,
  request: TurnRequest,
  state: {
    threadId: string;
    usage: TokenUsage | undefined;
    rateLimits: RateLimitSnapshot | undefined;
    lastAgentMessage: string;
  }
): Generator<MessageChunk> {
  let result: ResultChunk;
  if (status === 'completed') {
    result = { type: 'result' };
    if (request.hasOutputFormat && state.lastAgentMessage) {
      // Codex returns structured output as the final message's text. Parse it onto
      // structuredOutput so the dag-executor handles all providers uniformly.
      try {
        result.structuredOutput = JSON.parse(state.lastAgentMessage);
      } catch {
        getLog().warn(
          { outputPreview: state.lastAgentMessage.slice(0, 200) },
          'codex.structured_output_not_json'
        );
        yield {
          type: 'warning',
          code: 'codex.structured_output_not_json',
          message:
            'Structured output requested but Codex returned non-JSON text. ' +
            'Downstream $nodeId.output.field references may not evaluate correctly.',
        };
      }
    }
  } else if (status === 'failed' && error) {
    const { failureClass, resetAt } = classifyTurnError(error.codexErrorInfo, state.rateLimits);
    const vendorText = [error.message, error.additionalDetails].filter(Boolean).join('\n');
    getLog().error({ failureClass, codexErrorInfo: error.codexErrorInfo }, 'codex.turn_failed');
    result = failureResult(
      failureClass,
      'codex_turn_failed',
      withModelAccessAdvice(vendorText, request.model)
    );
    if (resetAt && result.failure) result.failure.resetAt = resetAt;
  } else {
    // An interrupt Archon did not send, or a failed status with no error attached.
    getLog().error({ status }, 'codex.turn_ended_without_completion');
    result = failureResult('unknown', 'codex_turn_failed', `Codex turn ended ${status}`);
  }
  result.sessionId = state.threadId;
  if (state.usage) result.tokens = state.usage;
  // Reaching a turn means `thread/resume` succeeded.
  if (request.resumeSessionId) result.resumed = true;
  yield result;
}

function withModelAccessAdvice(evidence: string, model: string | undefined): string {
  return isModelAccessError(evidence)
    ? `${buildModelAccessMessage(model)}\n\n${evidence}`
    : evidence;
}

/**
 * Spawn errnos that fail the same way every time: the binary path is missing, not
 * executable, the wrong architecture, or not a file. Others, such as EMFILE, EAGAIN and
 * ENOMEM, are the machine running short and may clear.
 */
const MISCONFIGURED_SPAWN_ERRNOS: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'ENOEXEC',
  'EISDIR',
  'ENOTDIR',
]);

/**
 * The class of a failure that ended a turn before `turn/completed`, from how the process
 * ended. A process that exits on its own before answering any request never ran a turn:
 * the binary has no `app-server` or rejects a flag, and another attempt fails the same
 * way. Any other process end is a process failure, which is what `transient` names.
 *
 * JSON-RPC errors are not classified by code: Codex answers an unknown method, a missing
 * thread and a config it cannot load all with -32600, so the code says nothing about
 * whether the setup must change.
 */
function failureClassOfStop(error: unknown): ProviderFailureClass {
  if (!(error instanceof ConnectionClosedError)) return failureClassOfThrown(error);
  const { end } = error;
  if (end.kind === 'spawn_failed') {
    return end.error.code !== undefined && MISCONFIGURED_SPAWN_ERRNOS.has(end.error.code)
      ? 'misconfigured'
      : 'transient';
  }
  return error.beforeFirstResponse && end.signal === null ? 'misconfigured' : 'transient';
}

// ─── Codex Provider ──────────────────────────────────────────────────────

export class CodexProvider implements IAgentProvider {
  /**
   * @param spawner starts the app-server process; tests pass a fake.
   * @param shutdownGraceMs each cancel and shutdown wait; tests shorten it.
   */
  constructor(
    private readonly spawner?: Spawner,
    private readonly shutdownGraceMs = SHUTDOWN_GRACE_MS
  ) {}

  getCapabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  /**
   * One call is one Codex turn on its own app-server process. A failure ends in a
   * `result` carrying a typed `failure`, and the engine decides whether to try again.
   * Every turn ends in `settled`. Only cancellation throws.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const abortSignal = requestOptions?.abortSignal;
    let resultReported = false;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let connection: AppServerConnection | undefined;

    // Cancel: interrupt the turn so Codex stops its command, then end the process. The
    // stream below sees the process end and throws `Query aborted`. A Codex that does not
    // answer the interrupt within the grace period is shut down anyway.
    const onAbort = (): void => {
      const open = connection;
      if (!open) return;
      const interrupt =
        threadId && turnId
          ? open.request('turn/interrupt', { threadId, turnId }).catch((error: unknown) => {
              getLog().debug({ err: error }, 'codex.interrupt_failed');
            })
          : Promise.resolve();
      void settlesWithin(interrupt, this.shutdownGraceMs).then(answered => {
        if (!answered) getLog().warn({ threadId, turnId }, 'codex.interrupt_unanswered');
        return open.shutdown(this.shutdownGraceMs);
      });
    };

    const codexConfig = parseCodexConfig(requestOptions?.assistantConfig ?? {});
    const model = requestOptions?.model ?? codexConfig.model;
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }
      const providerWarnings: ProviderWarning[] = [];
      let mcpServers: CodexConfig | undefined;

      if (requestOptions?.nodeConfig?.mcp) {
        const mcpPath = requestOptions.nodeConfig.mcp;
        const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd, {
          ...process.env,
          ...requestOptions.env,
        });
        mcpServers = buildCodexMcpServers(servers);
        getLog().info({ serverNames, mcpPath }, 'codex.mcp_config_loaded');
        if (missingVars.length > 0) {
          const uniqueVars = [...new Set(missingVars)];
          getLog().warn({ missingVars: uniqueVars }, 'codex.mcp_env_vars_missing');
          providerWarnings.push({
            code: 'codex.mcp_env_vars_missing',
            message: `MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings - MCP servers may fail to authenticate.`,
          });
        }
      }
      for (const warning of providerWarnings) {
        yield { type: 'warning', ...warning };
      }

      const binary = await resolveCodexBinary(codexConfig.codexBinaryPath);
      const env = buildCodexEnv(requestOptions?.env);
      // `CODEX_API_KEY` opts a turn into API-key auth. Without it Codex uses the user's
      // own login in their CODEX_HOME. The ephemeral store keeps the key out of that home.
      const apiKey = env.CODEX_API_KEY || undefined;
      const { outputSchema, hasOutputFormat } = buildOutputSchema(requestOptions);
      const effort = resolveModelReasoningEffort(
        requestOptions?.nodeConfig,
        codexConfig.modelReasoningEffort
      );

      connection = AppServerConnection.start(
        binary,
        apiKey ? ['-c', 'cli_auth_credentials_store="ephemeral"'] : [],
        env,
        this.spawner
      );
      // An abort while the setup above awaited found no process to stop.
      if (abortSignal?.aborted) throw new Error('Query aborted');

      const stream = streamTurn({
        connection,
        apiKey,
        cwd,
        resumeSessionId,
        threadParams: {
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          ...(model ? { model } : {}),
          config: buildThreadConfig(codexConfig, mcpServers, isWorkflowNode(requestOptions)),
        },
        turnParams: {
          input: [
            { type: 'text', text: buildEffectivePrompt(prompt, requestOptions), text_elements: [] },
          ],
          ...(effort ? { effort } : {}),
          ...(outputSchema !== undefined ? { outputSchema } : {}),
        },
        hasOutputFormat,
        model,
        onThread: id => {
          threadId = id;
        },
        onTurn: id => {
          turnId = id;
        },
      });
      // A Codex turn has no background work: its result ends it.
      for await (const chunk of closeOpenToolCalls(stream, { resultEndsTurn: true })) {
        if (chunk.type === 'result') {
          // An interrupted turn completes before its process ends; a cancel is not a result.
          if (abortSignal?.aborted) throw new Error('Query aborted');
          resultReported = true;
        }
        yield chunk;
      }
    } catch (error) {
      if (abortSignal?.aborted === true) {
        throw new Error('Query aborted');
      }
      getLog().error({ err: error, resultReported }, 'query_error');
      if (!resultReported) {
        const failureClass = failureClassOfStop(error);
        const subtype =
          error instanceof JsonRpcError ? 'codex_request_failed' : 'codex_query_failed';
        const result = failureResult(
          failureClass,
          subtype,
          withModelAccessAdvice(
            error instanceof ConnectionClosedError ? error.evidence : (error as Error).message,
            model
          )
        );
        if (threadId) result.sessionId = threadId;
        yield result;
      }
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      await connection?.shutdown(this.shutdownGraceMs);
    }
    // A Codex turn has no background work: once its result is in, nothing more runs.
    yield { type: 'settled' };
  }

  getType(): string {
    return 'codex';
  }
}
