/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 */
import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type TurnOptions,
  type TurnCompletedEvent,
  type ThreadItem,
  type ThreadStartedEvent,
} from '@openai/codex-sdk';
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
import {
  sessionPreview,
  truncateToolOutput,
  type ProviderFailureClass,
} from '@archon/provider-contract';
import { failureClassOfThrown, failureResult } from '../shared/failure';
import { clampEffort } from '@archon/paths/effort';
import { CODEX_EFFORTS, parseCodexConfig } from './config';
import { CODEX_CAPABILITIES } from './capabilities';
import { resolveCodexBinaryPath } from './binary-resolver';
import { createLogger } from '@archon/paths';
import { loadMcpConfig } from '../mcp/config';
import {
  hasOpenAdditionalProperties,
  normalizeJsonSchemaForOpenAiStrict,
} from '../shared/structured-output';
import { withResumedOutcome, resumedOutcome } from '../shared/resumed';
import { closeOpenToolCalls } from '../shared/tool-calls';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

type CodexConfigOverrides = NonNullable<CodexOptions['config']>;
type CodexConfigValue = CodexConfigOverrides[string];

// Singleton Codex instance (async because binary path resolution is async)
let codexInstance: Codex | null = null;
let codexInitPromise: Promise<Codex> | null = null;

/** Reset singleton state. Exported for tests only. */
export function resetCodexSingleton(): void {
  codexInstance = null;
  codexInitPromise = null;
}

/**
 * Get or create Codex SDK instance.
 */
async function getCodex(configCodexBinaryPath?: string): Promise<Codex> {
  if (codexInstance) return codexInstance;

  if (!codexInitPromise) {
    codexInitPromise = (async (): Promise<Codex> => {
      const codexPathOverride = await resolveCodexBinaryPath(configCodexBinaryPath);
      const instance = new Codex({ codexPathOverride });
      codexInstance = instance;
      return instance;
    })().catch(err => {
      codexInitPromise = null;
      throw err;
    });
  }
  return codexInitPromise;
}

/**
 * Resolve Codex's `modelReasoningEffort` from Archon's inputs.
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

/**
 * Build thread options for Codex SDK
 */
function buildThreadOptions(
  cwd: string,
  model?: string,
  assistantConfig?: Record<string, unknown>,
  nodeConfig?: NodeConfig
): ThreadOptions {
  const config = parseCodexConfig(assistantConfig ?? {});
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    approvalPolicy: 'never',
    model: model ?? config.model,
    modelReasoningEffort: resolveModelReasoningEffort(nodeConfig, config.modelReasoningEffort),
    webSearchMode: config.webSearchMode,
    additionalDirectories: config.additionalDirectories,
  };
}

function buildCodexEnv(requestEnv: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // Managed project env intentionally overrides inherited process env for project-scoped execution.
  return { ...baseEnv, ...requestEnv };
}

function buildMcpEnvSource(
  requestEnv?: Record<string, string>
): Record<string, string | undefined> {
  return requestEnv ? { ...process.env, ...requestEnv } : process.env;
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

function toCodexConfigValue(value: unknown): CodexConfigValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const result: CodexConfigValue[] = [];
    for (const item of value) {
      const converted = toCodexConfigValue(item);
      if (converted !== undefined) result.push(converted);
    }
    return result;
  }

  if (typeof value === 'object' && value !== null) {
    const result: CodexConfigOverrides = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const converted = toCodexConfigValue(nestedValue);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }

  return undefined;
}

function setCodexConfigValue(target: CodexConfigOverrides, key: string, value: unknown): void {
  const converted = toCodexConfigValue(value);
  if (converted !== undefined) {
    target[key] = converted;
  }
}

function convertMcpServerConfigForCodex(
  serverConfig: Record<string, unknown>
): CodexConfigOverrides {
  const result: CodexConfigOverrides = {};

  for (const key of CODEX_MCP_PASSTHROUGH_KEYS) {
    if (key in serverConfig) {
      setCodexConfigValue(result, key, serverConfig[key]);
    }
  }

  // Archon's MCP JSON format uses `headers`; Codex config uses `http_headers`.
  if ('headers' in serverConfig && !('http_headers' in result)) {
    setCodexConfigValue(result, 'http_headers', serverConfig.headers);
  }

  return result;
}

function buildCodexMcpConfigOverrides(
  servers: Record<string, unknown>
): CodexConfigOverrides | undefined {
  const mcpServers: CodexConfigOverrides = {};

  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (typeof serverConfig !== 'object' || serverConfig === null || Array.isArray(serverConfig)) {
      getLog().warn(
        { serverName, valueType: typeof serverConfig },
        'codex.mcp_server_config_not_object'
      );
      continue;
    }

    const converted = convertMcpServerConfigForCodex(serverConfig as Record<string, unknown>);
    if (Object.keys(converted).length > 0) {
      mcpServers[serverName] = converted;
    }
  }

  if (Object.keys(mcpServers).length === 0) return undefined;
  return { mcp_servers: mcpServers };
}

function isWorkflowNode(requestOptions?: SendQueryOptions): boolean {
  const nodeId = requestOptions?.nodeConfig?.nodeId;
  return typeof nodeId === 'string' && nodeId.trim().length > 0;
}

function withWorkflowSkillCatalogDisabled(config?: CodexConfigOverrides): CodexConfigOverrides {
  return {
    ...(config ?? {}),
    skills: { include_instructions: false },
  };
}

function isWorkflowSkillCatalogConfigUnsupported(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  const namesCatalogSetting =
    normalized.includes('skills.include_instructions') ||
    normalized.includes('include_instructions');
  const isConfigRejection =
    normalized.includes('config') ||
    normalized.includes('unknown field') ||
    normalized.includes('unknown key') ||
    normalized.includes('unrecognized') ||
    normalized.includes('failed to parse');
  return namesCatalogSetting && isConfigRejection;
}

// Maps slugs that ChatGPT-plan accounts now reject (previously shipped as Archon
// suggestions/defaults) to a current, plan-accepted slug to suggest instead.
const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.6-sol',
  'gpt-5.2-codex': 'gpt-5.6-sol',
  'gpt-5.2': 'gpt-5.6-sol',
};

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

function extractUsageFromCodexEvent(event: TurnCompletedEvent): TokenUsage | undefined {
  if (!event.usage) {
    getLog().warn({ eventType: event.type }, 'codex.usage_null_on_turn_completed');
    return undefined;
  }
  return {
    input: event.usage.input_tokens,
    output: event.usage.output_tokens,
    cacheRead: event.usage.cached_input_tokens,
    cacheWrite: event.usage.cache_write_input_tokens,
  };
}

// ─── Turn Options Builder ────────────────────────────────────────────────

/**
 * Build turn options for a single Codex turn.
 * Handles output schema from both requestOptions and nodeConfig (workflow path).
 */
function buildTurnOptions(requestOptions?: SendQueryOptions): {
  turnOptions: TurnOptions;
  hasOutputFormat: boolean;
} {
  const turnOptions: TurnOptions = {};
  // Preserve the original precedence: an explicit `outputFormat` wins over
  // `nodeConfig.output_format` even when its `.schema` is undefined. Note the
  // resulting asymmetry: if `outputFormat` is set but `.schema` is undefined,
  // `rawSchema` is undefined (no schema sent) yet `hasOutputFormat` is still
  // true — the stream accumulator runs and JSON.parses the response text.
  const rawSchema =
    requestOptions?.outputFormat !== undefined
      ? requestOptions.outputFormat.schema
      : requestOptions?.nodeConfig?.output_format;
  const hasOutputFormat = !!(
    requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
  );
  if (rawSchema !== undefined) {
    // OpenAI Structured Outputs strict-mode requires additionalProperties:false
    // on every object schema (HTTP 400 invalid_json_schema otherwise). Workflow
    // authors write portable output_format schemas, so normalize here before
    // handing the schema to the Codex SDK. See issue #1843.
    if (hasOpenAdditionalProperties(rawSchema)) {
      // The normalizer is about to rewrite an open-record `additionalProperties`
      // (e.g. `{ type: 'string' }` or `true`) to `false`. OpenAI would 400 the
      // open form anyway, but the author never declared a closed object — warn
      // so the silent narrowing is visible rather than a surprise at runtime.
      getLog().warn({ schema: rawSchema }, 'codex.output_format_open_record_closed');
    }
    turnOptions.outputSchema = normalizeJsonSchemaForOpenAiStrict(rawSchema);
  }
  // Signal assignment is intentionally per-attempt (in sendQuery's retry
  // loop), not here. Reusing a single AbortSignal across retries can poison
  // later attempts once any earlier attempt's subprocess is SIGTERM'd.
  // See issue #1266.
  return { turnOptions, hasOutputFormat };
}

// ─── Effective Prompt Builder ────────────────────────────────────────────

/**
 * Fold the request/node-level systemPrompt into the user prompt.
 *
 * The Codex SDK (verified at @openai/codex-sdk 0.144.5) exposes NO
 * instructions/system-prompt channel on ThreadOptions or TurnOptions, so the
 * only delivery mechanism is prepending to the prompt string, separated by
 * the same `---` delimiter augmentPromptForJsonSchema uses. See issue #1837.
 *
 * Precedence mirrors the Pi provider: request-level systemPrompt wins over
 * node-level. Only string / string[] are supported; SystemPromptPreset
 * objects are Claude-specific and dropped with a WARN (the orchestrator
 * already sends non-Claude providers a plain string).
 *
 * The prepend intentionally repeats on EVERY turn, including resumed
 * threads: the provider cannot know whether a resumed session's earlier
 * turns carried the instructions (the session may predate this fix), and
 * both the resume-failure fallback and cold retry attempts start fresh
 * threads where first-turn-only logic would drop the instructions exactly
 * when they are most needed. This matches Claude, which receives the
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

/**
 * The `tool_call` for an item that runs a tool, or `undefined` for an item that does not.
 * `title` is what the operator reads (the command, the query, `server/tool`); `name` is the
 * kind of tool.
 */
function toolCallOf(item: ThreadItem): ToolCallEvent | undefined {
  switch (item.type) {
    case 'command_execution':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'command_execution',
        title: item.command,
        rawInput: { command: item.command },
      };
    case 'web_search':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'web_search',
        title: item.query,
        rawInput: { query: item.query },
      };
    case 'mcp_tool_call': {
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
    case 'file_change':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'file_change',
        rawInput: { changes: item.changes },
      };
    default:
      return undefined;
  }
}

/** The `tool_call_update` that closes a completed tool item. */
function toolCallUpdateOf(
  item: Extract<
    ThreadItem,
    { type: 'command_execution' | 'web_search' | 'mcp_tool_call' | 'file_change' }
  >
): ToolCallUpdateEvent {
  switch (item.type) {
    case 'command_execution': {
      const update: ToolCallUpdateEvent = {
        type: 'tool_call_update',
        toolCallId: item.id,
        status:
          item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0)
            ? 'failed'
            : item.status === 'completed'
              ? 'completed'
              : 'cancelled',
        ...truncateToolOutput(item.aggregated_output),
      };
      if (item.exit_code !== undefined) update.exitCode = item.exit_code;
      return update;
    }
    case 'web_search':
      return { type: 'tool_call_update', toolCallId: item.id, status: 'completed' };
    case 'mcp_tool_call':
      if (item.status === 'failed') {
        return {
          type: 'tool_call_update',
          toolCallId: item.id,
          status: 'failed',
          ...truncateToolOutput(item.error?.message ?? 'MCP tool failed'),
        };
      }
      return {
        type: 'tool_call_update',
        toolCallId: item.id,
        status: 'completed',
        ...truncateToolOutput(item.result?.content ? JSON.stringify(item.result.content) : ''),
      };
    case 'file_change': {
      if (item.status !== 'failed') {
        return { type: 'tool_call_update', toolCallId: item.id, status: 'completed' };
      }
      // The SDK's type omits it, but a failed change can carry the reason.
      const rawError = 'error' in item ? (item as { error?: unknown }).error : undefined;
      const reason =
        typeof rawError === 'string'
          ? rawError
          : typeof rawError === 'object' && rawError !== null && 'message' in rawError
            ? String((rawError as { message: unknown }).message)
            : undefined;
      const failed: ToolCallUpdateEvent = {
        type: 'tool_call_update',
        toolCallId: item.id,
        status: 'failed',
      };
      return reason ? { ...failed, ...truncateToolOutput(reason) } : failed;
    }
  }
}

/**
 * Normalize raw Codex SDK events into Archon MessageChunks.
 * Handles structured output normalization (Codex returns JSON inline in text).
 */
async function* streamCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
  hasOutputFormat: boolean,
  threadId: string | null | undefined,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const startedToolItemIds = new Set<string>();
  const completedToolItemIds = new Set<string>();
  let accumulatedText = '';

  // A new thread's id is assigned during the run via the `thread.started` event
  // (the SDK emits it only for new threads), not synchronously on startThread().
  // Capture it so the terminal result chunk surfaces a resumable sessionId —
  // persist_session and suspend/resume depend on it. A resumed thread keeps the
  // snapshot id (no thread.started fires), so the seeded value stays correct.
  let resolvedThreadId: string | null | undefined = threadId;

  if (abortSignal?.aborted) {
    getLog().info('query_aborted_before_stream');
    throw new Error('Query aborted');
  }

  // If the iterator closes without a terminal event (e.g. the model was
  // rejected before the turn even started), we synthesize a fail-stop result
  // after the loop so the dag-executor's `msg.isError` branch catches it
  // — matching Claude's contract. Both terminal branches below `return`,
  // so reaching the post-loop block can only mean no terminal fired.
  const streamErrors: string[] = [];

  for await (const event of events) {
    if (abortSignal?.aborted) {
      getLog().info('query_aborted_between_events');
      throw new Error('Query aborted');
    }

    if (event.type === 'thread.started') {
      // Capture the new thread's id. Its SDK doc comment reads: "The identifier
      // of the new thread. Can be used to resume the thread later." This is the
      // only place a new thread's id surfaces. `continue` — the event carries no
      // user-facing content, only this metadata.
      const startedThreadId = (event as ThreadStartedEvent).thread_id;
      if (startedThreadId) {
        resolvedThreadId = startedThreadId;
        getLog().info(
          { sessionIdPreview: sessionPreview(startedThreadId) },
          'codex.thread_started'
        );
      } else {
        // The SDK types thread_id as a non-empty string, so this should never
        // fire. If it does, a new thread would surface sessionId: undefined and
        // the dag-executor would treat the run as session-less — silently
        // dropping any persist_session continuity. Warn rather than degrade
        // quietly (CLAUDE.md: Fail Fast + Explicit Errors).
        getLog().warn(
          {
            ...(resolvedThreadId
              ? { snapshotSessionIdPreview: sessionPreview(resolvedThreadId) }
              : {}),
          },
          'codex.thread_started_missing_id'
        );
      }
      continue;
    }

    if (event.type === 'item.started') {
      const item = event.item as ThreadItem;
      getLog().debug(
        { eventType: event.type, itemType: item.type, itemId: item.id },
        'item_started'
      );
      const call = toolCallOf(item);
      if (call && !startedToolItemIds.has(item.id)) {
        startedToolItemIds.add(item.id);
        yield call;
      }
      continue;
    }

    if (event.type === 'error') {
      const errorEvent = event as { message: string };
      getLog().error({ message: errorEvent.message }, 'stream_error');
      // Whether an error is fatal is decided when the stream terminates: turn.completed
      // means the SDK recovered (Codex retries MCP client errors internally), so the
      // operator sees nothing; loop closure without a terminal makes every error the
      // failure's evidence. The message is prose, so no error is singled out as the cause.
      streamErrors.push(errorEvent.message);
      continue;
    }

    if (event.type === 'turn.failed') {
      const errorObj = (event as { error?: { message?: string } }).error;
      const errorMessage = errorObj?.message ?? 'Unknown error';
      getLog().error({ errorMessage }, 'turn_failed');
      yield codexFailureResult('unknown', 'codex_turn_failed', errorMessage, resolvedThreadId);
      return;
    }

    if (event.type === 'item.completed') {
      const item = event.item as ThreadItem;
      const logContext: Record<string, unknown> = {
        eventType: event.type,
        itemType: item.type,
        itemId: item.id,
      };
      if (item.type === 'command_execution') logContext.command = item.command;
      getLog().debug(logContext, 'item_completed');

      switch (item.type) {
        case 'agent_message':
          if (item.text) {
            // Multiple agent_message items can arrive in one turn (preamble + answer);
            // keep only the last — it's the authoritative structured-output candidate.
            if (hasOutputFormat) accumulatedText = item.text;
            yield { type: 'agent_message_chunk', text: item.text };
          }
          break;

        case 'reasoning':
          if (item.text) yield { type: 'agent_thought_chunk', text: item.text };
          break;

        case 'command_execution':
        case 'web_search':
        case 'mcp_tool_call':
        case 'file_change': {
          if (completedToolItemIds.has(item.id)) {
            getLog().warn(
              { itemId: item.id, itemType: item.type },
              'tool_item_duplicate_completion'
            );
            break;
          }
          completedToolItemIds.add(item.id);
          // A file change is reported only once it is applied, and a start can be missed:
          // open the call here so its update always has one.
          if (!startedToolItemIds.has(item.id)) {
            startedToolItemIds.add(item.id);
            const call = toolCallOf(item);
            if (call) yield call;
          }
          if (item.type === 'mcp_tool_call' && item.status === 'failed') {
            getLog().warn(
              { server: item.server, tool: item.tool, error: item.error, itemId: item.id },
              'mcp_tool_call_failed'
            );
          }
          yield toolCallUpdateOf(item);
          break;
        }

        default:
          // todo_list and error items have no reader; they stay in the debug log above.
          break;
      }
    }

    if (event.type === 'turn.completed') {
      getLog().debug('turn_completed');
      const usage = extractUsageFromCodexEvent(event as TurnCompletedEvent);

      // Codex returns structured output inline in agent_message text.
      // Normalize: parse as JSON and put on structuredOutput so the
      // dag-executor can handle all providers uniformly.
      let structuredOutput: unknown;
      if (hasOutputFormat && accumulatedText) {
        try {
          structuredOutput = JSON.parse(accumulatedText);
          getLog().debug('codex.structured_output_parsed');
        } catch {
          getLog().warn(
            { outputPreview: accumulatedText.slice(0, 200) },
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

      // Built by assignment on a typed value so a misspelled key fails to compile.
      const result: ResultChunk = { type: 'result' };
      if (resolvedThreadId) result.sessionId = resolvedThreadId;
      if (usage) result.tokens = usage;
      if (structuredOutput !== undefined) result.structuredOutput = structuredOutput;
      yield result;
      return;
    }
  }

  // Reaching here means the iterator closed without yielding turn.completed
  // or turn.failed (both branches `return` immediately). Common cause: model
  // rejected by the API (model not supported, auth refused) before the turn
  // started. Surface as a fail-stop. The dag-executor's `msg.isError` branch
  // (dag-executor.ts: throws `Node '<id>' failed: SDK returned <subtype>`)
  // turns this into a thrown node failure — distinct from the empty-output
  // guard further down, which returns `{ state: 'failed' }` for AI nodes
  // that streamed nothing but never raised an isError.
  const message =
    streamErrors.length > 0
      ? streamErrors.join('\n')
      : 'Codex stream closed without turn.completed or turn.failed';
  getLog().error({ message }, 'stream_incomplete');
  yield codexFailureResult('unknown', 'codex_stream_incomplete', message, resolvedThreadId);
}

/**
 * A failed Codex turn; the thread id rides along for resume. The Codex SDK reports
 * failures as message strings (`turn.failed`, `error` events and its own thrown errors
 * carry no code, status or error type), so they are `unknown`. Only a failure Archon's
 * setup checks classified, or a spawn errno, has a class of its own.
 */
function codexFailureResult(
  failureClass: ProviderFailureClass,
  errorSubtype: string,
  evidence: string,
  sessionId: string | null | undefined
): ResultChunk {
  const result = failureResult(failureClass, errorSubtype, evidence);
  if (sessionId) result.sessionId = sessionId;
  return result;
}

// ─── Codex Provider ──────────────────────────────────────────────────────

/**
 * Codex AI agent provider.
 * Implements IAgentProvider with Codex SDK integration.
 *
 * sendQuery orchestrates the following internal helpers:
 * - buildThreadOptions: SDK thread configuration
 * - buildTurnOptions: per-turn configuration (output schema, abort signal)
 * - buildEffectivePrompt: systemPrompt delivery via prompt prepend (no SDK channel)
 * - streamCodexEvents: raw SDK event normalization into MessageChunks
 * - codexFailureResult: the typed failure a Codex error becomes
 */
export class CodexProvider implements IAgentProvider {
  private async createCodexClient(
    configCodexBinaryPath: string | undefined,
    requestEnv?: Record<string, string>,
    codexConfigOverrides?: CodexConfigOverrides
  ): Promise<Codex> {
    if ((!requestEnv || Object.keys(requestEnv).length === 0) && !codexConfigOverrides) {
      return getCodex(configCodexBinaryPath);
    }
    const codexOptions: CodexOptions = {
      codexPathOverride: await resolveCodexBinaryPath(configCodexBinaryPath),
      ...(requestEnv && Object.keys(requestEnv).length > 0
        ? { env: buildCodexEnv(requestEnv) }
        : {}),
      ...(codexConfigOverrides ? { config: codexConfigOverrides } : {}),
    };
    return new Codex(codexOptions);
  }

  getCapabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  /**
   * One call is one Codex turn. A failure ends in a `result` carrying a typed `failure`,
   * and the engine decides whether to try again. Every turn ends in `settled`. Only
   * cancellation throws.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const abortSignal = requestOptions?.abortSignal;
    let resultReported = false;
    let threadId: string | null | undefined;

    try {
      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }
      const assistantConfig = requestOptions?.assistantConfig ?? {};
      const codexConfig = parseCodexConfig(assistantConfig);
      const providerWarnings: ProviderWarning[] = [];
      let declaredMcpConfigOverrides: CodexConfigOverrides | undefined;

      if (requestOptions?.nodeConfig?.mcp) {
        const mcpPath = requestOptions.nodeConfig.mcp;
        const { servers, serverNames, missingVars } = await loadMcpConfig(
          mcpPath,
          cwd,
          buildMcpEnvSource(requestOptions.env)
        );
        declaredMcpConfigOverrides = buildCodexMcpConfigOverrides(servers);
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

      const suppressWorkflowSkillCatalog = isWorkflowNode(requestOptions);
      const initialConfigOverrides = suppressWorkflowSkillCatalog
        ? withWorkflowSkillCatalogDisabled(declaredMcpConfigOverrides)
        : declaredMcpConfigOverrides;

      for (const warning of providerWarnings) {
        yield { type: 'warning', ...warning };
      }

      // 1. Initialize SDK and build thread options
      let codex = await this.createCodexClient(
        codexConfig.codexBinaryPath,
        requestOptions?.env,
        initialConfigOverrides
      );
      const threadOptions = buildThreadOptions(
        cwd,
        requestOptions?.model,
        assistantConfig,
        requestOptions?.nodeConfig
      );

      // 2. Create or resume thread
      let sessionResumeFailed = false;
      let thread;
      if (resumeSessionId) {
        getLog().debug({ sessionIdPreview: sessionPreview(resumeSessionId) }, 'resuming_thread');
        try {
          thread = codex.resumeThread(resumeSessionId, threadOptions);
        } catch (error) {
          getLog().error(
            { err: error, sessionIdPreview: sessionPreview(resumeSessionId) },
            'resume_thread_failed'
          );
          thread = codex.startThread(threadOptions);
          sessionResumeFailed = true;
        }
      } else {
        getLog().debug({ cwd }, 'starting_new_thread');
        thread = codex.startThread(threadOptions);
      }
      threadId = thread.id;

      if (sessionResumeFailed) {
        yield {
          type: 'warning',
          code: 'codex.resume_failed',
          message: 'Could not resume previous session. Starting fresh conversation.',
        };
      }

      // 3. Build turn options and the effective prompt (systemPrompt prepend).
      const { turnOptions, hasOutputFormat } = buildTurnOptions(requestOptions);
      const effectivePrompt = buildEffectivePrompt(prompt, requestOptions);
      if (abortSignal) turnOptions.signal = abortSignal;

      // 4. Run and consume the streamed turn. Codex starts its subprocess lazily while
      // events are iterated, so a binary that rejects the skill-catalog override fails
      // here. That one config probe is re-run once without the override, and only
      // before any event was emitted, so no output is ever streamed twice.
      let providerEventEmitted = false;
      let skillCatalogCompatibilityFallbackUsed = false;
      while (true) {
        try {
          const result = await thread.runStreamed(effectivePrompt, turnOptions);
          for await (const chunk of withResumedOutcome(
            closeOpenToolCalls(
              streamCodexEvents(
                result.events as AsyncIterable<Record<string, unknown>>,
                hasOutputFormat,
                thread.id,
                abortSignal
              ),
              // A Codex turn has no background work: its result ends it.
              { resultEndsTurn: true }
            ),
            resumedOutcome(resumeSessionId, !sessionResumeFailed)
          )) {
            providerEventEmitted = true;
            if (chunk.type === 'result') resultReported = true;
            yield chunk;
          }
          break;
        } catch (error) {
          const err = error as Error;
          if (
            providerEventEmitted ||
            !suppressWorkflowSkillCatalog ||
            skillCatalogCompatibilityFallbackUsed ||
            !isWorkflowSkillCatalogConfigUnsupported(err.message)
          ) {
            throw error;
          }

          skillCatalogCompatibilityFallbackUsed = true;
          getLog().warn(
            { err, nodeId: requestOptions?.nodeConfig?.nodeId },
            'codex.workflow_skill_catalog_suppression_unsupported'
          );
          yield {
            type: 'warning',
            code: 'codex.skill_catalog_suppression_unsupported',
            message:
              'This Codex binary does not support suppressing the automatic skill catalog. Continuing with native skill discovery enabled.',
          };

          codex = await this.createCodexClient(
            codexConfig.codexBinaryPath,
            requestOptions?.env,
            declaredMcpConfigOverrides
          );
          if (resumeSessionId) {
            try {
              thread = codex.resumeThread(resumeSessionId, threadOptions);
            } catch (resumeError) {
              getLog().error(
                { err: resumeError, sessionIdPreview: sessionPreview(resumeSessionId) },
                'resume_thread_failed'
              );
              thread = codex.startThread(threadOptions);
              sessionResumeFailed = true;
              yield {
                type: 'warning',
                code: 'codex.resume_failed',
                message: 'Could not resume previous session. Starting fresh conversation.',
              };
            }
          } else {
            thread = codex.startThread(threadOptions);
          }
          threadId = thread.id;
        }
      }
    } catch (error) {
      const err = error as Error;
      if (abortSignal?.aborted === true) {
        throw new Error('Query aborted');
      }
      getLog().error({ err, resultReported }, 'query_error');
      // The turn already reported its one result; an error while the subprocess shut
      // down afterwards does not change that outcome.
      if (!resultReported) {
        // The model-access advice is written for the operator; the vendor text follows it.
        const evidence = isModelAccessError(err.message)
          ? `${buildModelAccessMessage(requestOptions?.model)}\n\n${err.message}`
          : err.message;
        // The SDK spawns the binary without a cwd, so ENOENT means the binary is missing.
        const failureClass =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'misconfigured'
            : failureClassOfThrown(err);
        yield codexFailureResult(failureClass, 'codex_query_failed', evidence, threadId);
      }
    }
    // A Codex turn has no background work: once its result is in, nothing more runs.
    yield { type: 'settled' };
  }

  getType(): string {
    return 'codex';
  }
}
