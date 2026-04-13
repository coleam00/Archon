/**
 * Claude Agent SDK wrapper
 * Provides async generator interface for streaming Claude responses
 *
 * Type Safety Pattern:
 * - Uses `Options` type from SDK for query configuration
 * - SDK message types have strict type checking for content blocks
 * - Content blocks are typed via inline assertions for clarity
 *
 * Authentication:
 * - CLAUDE_USE_GLOBAL_AUTH=true: Use global auth from `claude /login`, filter env tokens
 * - CLAUDE_USE_GLOBAL_AUTH=false: Use explicit tokens from env vars
 * - Not set: Auto-detect - use tokens if present in env, otherwise global auth
 */
import {
  query,
  type Options,
  type HookCallback,
  type HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';
import cliPath from '@anthropic-ai/claude-agent-sdk/embed';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  TokenUsage,
  ProviderCapabilities,
  NodeConfig,
} from '../types';
import { parseClaudeConfig } from './config';
import { CLAUDE_CAPABILITIES } from './capabilities';
import { createLogger } from '@archon/paths';
import { readFile } from 'fs/promises';
import { resolve, isAbsolute } from 'path';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/**
 * Content block type for assistant messages
 */
interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

function normalizeClaudeUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const total = usage.total_tokens;
  return {
    input,
    output,
    ...(typeof total === 'number' ? { total } : {}),
  };
}

/**
 * Build environment for Claude subprocess.
 *
 * process.env is already clean at this point:
 * - stripCwdEnv() at entry point removed CWD .env keys + CLAUDECODE markers
 * - ~/.archon/.env loaded with override:true as the trusted source
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const hasExplicitTokens = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_API_KEY
  );
  const authMode = hasExplicitTokens ? 'explicit' : 'global';
  getLog().info(
    { authMode },
    authMode === 'global' ? 'using_global_auth' : 'using_explicit_tokens'
  );
  return { ...process.env };
}

/** Max retries for transient subprocess failures */
const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'operation aborted'];

function classifySubprocessError(
  errorMessage: string,
  stderrOutput: string
): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  const combined = `${errorMessage} ${stderrOutput}`.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => combined.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => combined.includes(p))) return 'auth';
  if (SUBPROCESS_CRASH_PATTERNS.some(p => combined.includes(p))) return 'crash';
  return 'unknown';
}

function getFirstEventTimeoutMs(): number {
  const raw = process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
}

function buildFirstEventHangDiagnostics(
  subprocessEnv: Record<string, string>,
  model: string | undefined
): Record<string, unknown> {
  return {
    subprocessEnvKeys: Object.keys(subprocessEnv),
    parentClaudeKeys: Object.keys(process.env).filter(
      k => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_')
    ),
    model,
    platform: process.platform,
    uid: getProcessUid(),
    isTTY: process.stdout.isTTY ?? false,
    claudeCode: process.env.CLAUDECODE,
    claudeCodeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  };
}

class FirstEventTimeoutError extends Error {}

/**
 * Wraps an async generator so that the first call to .next() must resolve
 * within `timeoutMs`. If it doesn't, aborts the controller and throws.
 */
export async function* withFirstMessageTimeout<T>(
  gen: AsyncGenerator<T>,
  controller: AbortController,
  timeoutMs: number,
  diagnostics: Record<string, unknown>
): AsyncGenerator<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let firstValue: IteratorResult<T>;
  try {
    firstValue = await Promise.race([
      gen.next(),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new FirstEventTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof FirstEventTimeoutError) {
      controller.abort();
      getLog().error({ ...diagnostics, timeoutMs }, 'claude.first_event_timeout');
      throw new Error(
        'Claude Code subprocess produced no output within ' +
          timeoutMs +
          'ms. ' +
          'See logs for claude.first_event_timeout diagnostic dump. ' +
          'Details: https://github.com/coleam00/Archon/issues/1067'
      );
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }

  if (firstValue.done) return;
  yield firstValue.value;
  yield* gen;
}

/**
 * Returns the current process UID, or undefined on platforms that don't support it.
 */
export function getProcessUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

// ─── MCP Config Loading (absorbed from dag-executor) ───────────────────────

/**
 * Expand $VAR_NAME references in string-valued records from process.env.
 */
function expandEnvVarsInRecord(
  record: Record<string, unknown>,
  missingVars: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== 'string') {
      getLog().warn({ key, valueType: typeof val }, 'mcp_env_value_coerced_to_string');
      result[key] = String(val);
      continue;
    }
    result[key] = val.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) {
        missingVars.push(varName);
      }
      return envVal ?? '';
    });
  }
  return result;
}

function expandEnvVars(config: Record<string, unknown>): {
  expanded: Record<string, unknown>;
  missingVars: string[];
} {
  const result: Record<string, unknown> = {};
  const missingVars: string[] = [];
  for (const [serverName, serverConfig] of Object.entries(config)) {
    if (typeof serverConfig !== 'object' || serverConfig === null) {
      getLog().warn({ serverName, valueType: typeof serverConfig }, 'mcp_server_config_not_object');
      continue;
    }
    const server = { ...(serverConfig as Record<string, unknown>) };
    if (server.env && typeof server.env === 'object') {
      server.env = expandEnvVarsInRecord(server.env as Record<string, unknown>, missingVars);
    }
    if (server.headers && typeof server.headers === 'object') {
      server.headers = expandEnvVarsInRecord(
        server.headers as Record<string, unknown>,
        missingVars
      );
    }
    result[serverName] = server;
  }
  return { expanded: result, missingVars };
}

/**
 * Load MCP server config from a JSON file and expand environment variables.
 */
export async function loadMcpConfig(
  mcpPath: string,
  cwd: string
): Promise<{ servers: Record<string, unknown>; serverNames: string[]; missingVars: string[] }> {
  const fullPath = isAbsolute(mcpPath) ? mcpPath : resolve(cwd, mcpPath);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`MCP config file not found: ${mcpPath} (resolved to ${fullPath})`);
    }
    throw new Error(`Failed to read MCP config file: ${mcpPath} — ${e.message}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (parseErr) {
    const detail = (parseErr as SyntaxError).message;
    throw new Error(`MCP config file is not valid JSON: ${mcpPath} — ${detail}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP config must be a JSON object (Record<string, ServerConfig>): ${mcpPath}`);
  }

  const { expanded, missingVars } = expandEnvVars(parsed);
  const serverNames = Object.keys(expanded);
  return { servers: expanded, serverNames, missingVars };
}

// ─── SDK Hooks Building (absorbed from dag-executor) ───────────────────────

/** YAML hook matcher shape (matches @archon/workflows/schemas/dag-node WorkflowNodeHooks) */
interface YAMLHookMatcher {
  matcher?: string;
  response: unknown;
  timeout?: number;
}

type SDKHooksMap = Partial<
  Record<
    string,
    {
      matcher?: string;
      hooks: ((
        input: unknown,
        toolUseID: string | undefined,
        options: { signal: AbortSignal }
      ) => Promise<unknown>)[];
      timeout?: number;
    }[]
  >
>;

/**
 * Convert declarative YAML hook definitions to SDK HookCallbackMatcher arrays.
 */
export function buildSDKHooksFromYAML(
  nodeHooks: Record<string, YAMLHookMatcher[] | undefined>
): SDKHooksMap {
  const sdkHooks: SDKHooksMap = {};

  for (const [event, matchers] of Object.entries(nodeHooks)) {
    if (!matchers) continue;
    sdkHooks[event] = matchers.map(m => ({
      ...(m.matcher ? { matcher: m.matcher } : {}),
      hooks: [async (): Promise<unknown> => m.response],
      ...(m.timeout ? { timeout: m.timeout } : {}),
    }));
  }

  if (Object.keys(sdkHooks).length === 0) {
    getLog().warn(
      { nodeHooksKeys: Object.keys(nodeHooks) },
      'claude.hooks_build_produced_empty_map'
    );
  }

  return sdkHooks;
}

// ─── Provider Warning Type ───────────────────────────────────────────────

/**
 * Structured provider warning. Providers collect these during translation;
 * callers convert them to system chunks before streaming starts.
 */
interface ProviderWarning {
  code: string;
  message: string;
}

// ─── NodeConfig → SDK Options Translation ──────────────────────────────────

/**
 * Translate nodeConfig into Claude SDK-specific options.
 * Called inside sendQuery when nodeConfig is present (workflow path).
 * Returns structured warnings that the caller should yield as system chunks.
 */
async function applyNodeConfig(
  options: Options,
  nodeConfig: NodeConfig,
  cwd: string
): Promise<ProviderWarning[]> {
  const warnings: ProviderWarning[] = [];
  // allowed_tools → tools
  if (nodeConfig.allowed_tools !== undefined) {
    options.tools = nodeConfig.allowed_tools;
  }

  // denied_tools → disallowedTools
  if (nodeConfig.denied_tools !== undefined) {
    options.disallowedTools = nodeConfig.denied_tools;
  }

  // hooks → build SDK hooks
  if (nodeConfig.hooks) {
    const builtHooks = buildSDKHooksFromYAML(
      nodeConfig.hooks as Record<string, YAMLHookMatcher[] | undefined>
    );
    if (Object.keys(builtHooks).length > 0) {
      // Merge with existing hooks (PostToolUse capture hook)
      const existingHooks = options.hooks as SDKHooksMap | undefined;
      for (const [event, matchers] of Object.entries(builtHooks)) {
        if (!matchers) continue;
        const existing = existingHooks?.[event] as HookCallbackMatcher[] | undefined;
        if (existing) {
          (options.hooks as Record<string, HookCallbackMatcher[]>)[event] = [
            ...(matchers as HookCallbackMatcher[]),
            ...existing,
          ];
        } else {
          (options.hooks as Record<string, HookCallbackMatcher[]>)[event] =
            matchers as HookCallbackMatcher[];
        }
      }
    }
  }

  // mcp → load config and set mcpServers + allowedTools wildcards
  if (nodeConfig.mcp) {
    const mcpPath = nodeConfig.mcp;
    const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd);
    options.mcpServers = servers as Options['mcpServers'];
    const mcpWildcards = serverNames.map(name => `mcp__${name}__*`);
    options.allowedTools = [...(options.allowedTools ?? []), ...mcpWildcards];
    getLog().info({ serverNames, mcpPath }, 'claude.mcp_config_loaded');
    if (missingVars.length > 0) {
      const uniqueVars = [...new Set(missingVars)];
      getLog().warn({ missingVars: uniqueVars }, 'claude.mcp_env_vars_missing');
      warnings.push({
        code: 'mcp_env_vars_missing',
        message: `MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings — MCP servers may fail to authenticate.`,
      });
    }
    // Haiku models don't support tool search (lazy loading for many tools)
    if (options.model?.toLowerCase().includes('haiku')) {
      getLog().warn({ model: options.model }, 'claude.mcp_haiku_tool_search_unsupported');
      warnings.push({
        code: 'mcp_haiku_tool_search',
        message:
          'Using Haiku model with MCP servers — tool search (lazy loading for many tools) is not supported on Haiku. Consider using Sonnet or Opus.',
      });
    }
  }

  // skills → AgentDefinition wrapping
  if (nodeConfig.skills) {
    const skills = nodeConfig.skills;
    const agentId = 'dag-node-skills';
    const agentTools = options.tools ? [...(options.tools as string[]), 'Skill'] : ['Skill'];
    const agentDef: {
      description: string;
      prompt: string;
      skills: string[];
      tools: string[];
      model?: string;
    } = {
      description: 'DAG node with skills',
      prompt: `You have preloaded skills: ${skills.join(', ')}. Use them when relevant.`,
      skills,
      tools: agentTools,
    };
    if (options.model) agentDef.model = options.model;
    options.agents = { [agentId]: agentDef };
    options.agent = agentId;
    if (!options.allowedTools?.includes('Skill')) {
      options.allowedTools = [...(options.allowedTools ?? []), 'Skill'];
    }
    getLog().info({ skills, agentId }, 'claude.skills_agent_created');
  }

  // effort
  if (nodeConfig.effort !== undefined) {
    options.effort = nodeConfig.effort as Options['effort'];
  }

  // thinking
  if (nodeConfig.thinking !== undefined) {
    options.thinking = nodeConfig.thinking as Options['thinking'];
  }

  // sandbox
  if (nodeConfig.sandbox !== undefined) {
    options.sandbox = nodeConfig.sandbox as Options['sandbox'];
  }

  // betas
  if (nodeConfig.betas !== undefined) {
    options.betas = nodeConfig.betas as Options['betas'];
  }

  // output_format (from nodeConfig, overrides base outputFormat if present)
  if (nodeConfig.output_format) {
    options.outputFormat = {
      type: 'json_schema',
      schema: nodeConfig.output_format,
    } as Options['outputFormat'];
  }

  // maxBudgetUsd from nodeConfig
  if (nodeConfig.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = nodeConfig.maxBudgetUsd;
  }

  // systemPrompt from nodeConfig
  if (nodeConfig.systemPrompt !== undefined) {
    options.systemPrompt = nodeConfig.systemPrompt;
  }

  // fallbackModel from nodeConfig
  if (nodeConfig.fallbackModel !== undefined) {
    options.fallbackModel = nodeConfig.fallbackModel;
  }

  return warnings;
}

// ─── Base Options Builder ────────────────────────────────────────────────

/** Queued tool result from SDK hooks, consumed during stream normalization. */
interface ToolResultEntry {
  toolName: string;
  toolOutput: string;
  toolCallId?: string;
}

/**
 * Build base Claude SDK options from cwd, request options, and assistant defaults.
 * Does not include nodeConfig translation — that is handled by applyNodeConfig.
 */
function buildBaseClaudeOptions(
  cwd: string,
  requestOptions: SendQueryOptions | undefined,
  assistantDefaults: ReturnType<typeof parseClaudeConfig>,
  controller: AbortController,
  stderrLines: string[],
  toolResultQueue: ToolResultEntry[],
  env: NodeJS.ProcessEnv
): Options {
  return {
    cwd,
    pathToClaudeCodeExecutable: cliPath,
    // Prevent Bun from auto-loading .env from the target repo cwd.
    // Without this, the Claude Code subprocess inherits repo secrets.
    executableArgs: ['--no-env-file'],
    env,
    model: requestOptions?.model ?? assistantDefaults.model,
    abortController: controller,
    ...(requestOptions?.outputFormat !== undefined
      ? { outputFormat: requestOptions.outputFormat }
      : {}),
    ...(requestOptions?.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: requestOptions.maxBudgetUsd }
      : {}),
    ...(requestOptions?.fallbackModel !== undefined
      ? { fallbackModel: requestOptions.fallbackModel }
      : {}),
    ...(requestOptions?.persistSession !== undefined
      ? { persistSession: requestOptions.persistSession }
      : {}),
    ...(requestOptions?.forkSession !== undefined
      ? { forkSession: requestOptions.forkSession }
      : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: requestOptions?.systemPrompt ?? { type: 'preset', preset: 'claude_code' },
    settingSources: assistantDefaults.settingSources ?? ['project'],
    hooks: buildToolCaptureHooks(toolResultQueue),
    stderr: (data: string): void => {
      const output = data.trim();
      if (!output) return;
      stderrLines.push(output);

      const isError =
        output.toLowerCase().includes('error') ||
        output.toLowerCase().includes('fatal') ||
        output.toLowerCase().includes('failed') ||
        output.toLowerCase().includes('exception') ||
        output.includes('at ') ||
        output.includes('Error:');

      const isInfoMessage =
        output.includes('Spawning Claude Code') ||
        output.includes('--output-format') ||
        output.includes('--permission-mode');

      if (isError && !isInfoMessage) {
        getLog().error({ stderr: output }, 'subprocess_error');
      }
    },
  };
}

// ─── Tool Capture Hooks ──────────────────────────────────────────────────

/**
 * Build SDK hooks that capture tool use results into a shared queue.
 * The queue is drained during stream normalization.
 */
function buildToolCaptureHooks(toolResultQueue: ToolResultEntry[]): Options['hooks'] {
  return {
    PostToolUse: [
      {
        hooks: [
          (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
            try {
              const toolName = (input as { tool_name?: string }).tool_name ?? 'unknown';
              const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
              const toolResponse = (input as { tool_response?: unknown }).tool_response;
              const output =
                typeof toolResponse === 'string'
                  ? toolResponse
                  : JSON.stringify(toolResponse ?? '');
              const maxLen = 10_000;
              toolResultQueue.push({
                toolName,
                toolOutput: output.length > maxLen ? output.slice(0, maxLen) + '...' : output,
                ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}),
              });
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
            try {
              const toolName = (input as { tool_name?: string }).tool_name ?? 'unknown';
              const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
              const rawError = (input as { error?: string }).error;
              if (rawError === undefined) {
                getLog().debug({ input }, 'claude.post_tool_use_failure_no_error_field');
              }
              const errorText = rawError ?? 'tool failed';
              const isInterrupt = (input as { is_interrupt?: boolean }).is_interrupt === true;
              const prefix = isInterrupt ? '⚠️ Interrupted' : '❌ Error';
              toolResultQueue.push({
                toolName,
                toolOutput: `${prefix}: ${errorText}`,
                ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}),
              });
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_failure_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
  };
}

// ─── Stream Normalizer ───────────────────────────────────────────────────

/**
 * Normalize raw Claude SDK events into Archon MessageChunks.
 * Drains the tool result queue between events (populated by SDK hooks).
 */
async function* streamClaudeMessages(
  events: AsyncGenerator,
  toolResultQueue: ToolResultEntry[]
): AsyncGenerator<MessageChunk> {
  for await (const msg of events) {
    // Drain tool results captured by hooks before processing the next event
    while (toolResultQueue.length > 0) {
      const tr = toolResultQueue.shift();
      if (tr) {
        yield {
          type: 'tool_result',
          toolName: tr.toolName,
          toolOutput: tr.toolOutput,
          ...(tr.toolCallId !== undefined ? { toolCallId: tr.toolCallId } : {}),
        };
      }
    }

    const event = msg as { type: string };

    if (event.type === 'assistant') {
      const message = msg as { message: { content: ContentBlock[] } };
      const content = message.message.content;

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'assistant', content: block.text };
        } else if (block.type === 'tool_use' && block.name) {
          yield {
            type: 'tool',
            toolName: block.name,
            toolInput: block.input ?? {},
            ...(block.id !== undefined ? { toolCallId: block.id } : {}),
          };
        }
      }
    } else if (event.type === 'system') {
      const sysMsg = msg as {
        subtype?: string;
        mcp_servers?: { name: string; status: string }[];
      };
      if (sysMsg.subtype === 'init' && sysMsg.mcp_servers) {
        const failed = sysMsg.mcp_servers.filter(s => s.status !== 'connected');
        if (failed.length > 0) {
          const names = failed.map(s => `${s.name} (${s.status})`).join(', ');
          yield { type: 'system', content: `MCP server connection failed: ${names}` };
        }
      } else {
        getLog().debug({ subtype: sysMsg.subtype }, 'claude.system_message_unhandled');
      }
    } else if (event.type === 'rate_limit_event') {
      const rateLimitMsg = msg as { rate_limit_info?: Record<string, unknown> };
      getLog().warn({ rateLimitInfo: rateLimitMsg.rate_limit_info }, 'claude.rate_limit_event');
      yield { type: 'rate_limit', rateLimitInfo: rateLimitMsg.rate_limit_info ?? {} };
    } else if (event.type === 'result') {
      const resultMsg = msg as {
        session_id?: string;
        is_error?: boolean;
        subtype?: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        structured_output?: unknown;
        total_cost_usd?: number;
        stop_reason?: string | null;
        num_turns?: number;
        model_usage?: Record<
          string,
          {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        >;
      };
      const tokens = normalizeClaudeUsage(resultMsg.usage);
      if (resultMsg.is_error) {
        getLog().error(
          { sessionId: resultMsg.session_id, errorSubtype: resultMsg.subtype },
          'claude.result_is_error'
        );
      }
      yield {
        type: 'result',
        sessionId: resultMsg.session_id,
        ...(tokens ? { tokens } : {}),
        ...(resultMsg.structured_output !== undefined
          ? { structuredOutput: resultMsg.structured_output }
          : {}),
        ...(resultMsg.is_error ? { isError: true, errorSubtype: resultMsg.subtype } : {}),
        ...(resultMsg.total_cost_usd !== undefined ? { cost: resultMsg.total_cost_usd } : {}),
        ...(resultMsg.stop_reason != null ? { stopReason: resultMsg.stop_reason } : {}),
        ...(resultMsg.num_turns !== undefined ? { numTurns: resultMsg.num_turns } : {}),
        ...(resultMsg.model_usage
          ? { modelUsage: resultMsg.model_usage as Record<string, unknown> }
          : {}),
      };
    }
  }

  // Drain any remaining tool results after the stream ends
  while (toolResultQueue.length > 0) {
    const tr = toolResultQueue.shift();
    if (tr) {
      yield {
        type: 'tool_result',
        toolName: tr.toolName,
        toolOutput: tr.toolOutput,
        ...(tr.toolCallId !== undefined ? { toolCallId: tr.toolCallId } : {}),
      };
    }
  }
}

// ─── Error Classification & Retry ────────────────────────────────────────

/**
 * Classify a subprocess error and enrich with stderr context.
 * Returns null if the error should be retried (caller handles retry logic).
 */
function classifyAndEnrichError(
  error: Error,
  stderrLines: string[],
  controller: AbortController
): { enrichedError: Error; errorClass: string; shouldRetry: boolean } {
  // If the controller was aborted by withFirstMessageTimeout, the original
  // timeout error carries the diagnostic message and #1067 breadcrumb.
  // Preserve it instead of collapsing into a generic "Query aborted".
  if (controller.signal.aborted) {
    if (error.message.includes('produced no output within')) {
      return { enrichedError: error, errorClass: 'timeout', shouldRetry: false };
    }
    return {
      enrichedError: new Error('Query aborted'),
      errorClass: 'aborted',
      shouldRetry: false,
    };
  }

  const stderrContext = stderrLines.join('\n');
  const errorClass = classifySubprocessError(error.message, stderrContext);

  if (errorClass === 'auth') {
    const enrichedError = new Error(
      `Claude Code auth error: ${error.message}${stderrContext ? ` (${stderrContext})` : ''}`
    );
    enrichedError.cause = error;
    return { enrichedError, errorClass, shouldRetry: false };
  }

  const enrichedMessage = stderrContext
    ? `Claude Code ${errorClass}: ${error.message} (stderr: ${stderrContext})`
    : `Claude Code ${errorClass}: ${error.message}`;
  const enrichedError = new Error(enrichedMessage);
  enrichedError.cause = error;
  const shouldRetry = errorClass === 'rate_limit' || errorClass === 'crash';
  return { enrichedError, errorClass, shouldRetry };
}

// ─── Claude Provider ───────────────────────────────────────────────────────

/**
 * Claude AI agent provider.
 * Implements IAgentProvider with full SDK integration.
 *
 * sendQuery orchestrates the following internal helpers:
 * - buildBaseClaudeOptions: SDK option construction
 * - applyNodeConfig: workflow nodeConfig → SDK option translation + warnings
 * - streamClaudeMessages: raw SDK event normalization into MessageChunks
 * - classifyAndEnrichError: error classification for retry decisions
 */
export class ClaudeProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    if (getProcessUid() === 0 && process.env.IS_SANDBOX !== '1') {
      throw new Error(
        'Claude Code SDK does not support bypassPermissions when running as root (UID 0). ' +
          'Run as a non-root user, set IS_SANDBOX=1, or use the Dockerfile which creates a non-root appuser.'
      );
    }
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  /**
   * Send a query to Claude and stream responses.
   * Orchestrates option building, nodeConfig translation, streaming, and retry.
   */
  // TODO(#1135): Pre-spawn env-leak gate was removed during provider extraction.
  // Caller-side enforcement (orchestrator, dag-executor) is tracked in #1135.
  // Providers must NOT implement security gates — the platform guarantees safety
  // before a provider runs.
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    let lastError: Error | undefined;
    const assistantDefaults = parseClaudeConfig(requestOptions?.assistantConfig ?? {});

    // Build subprocess env once (avoids re-logging auth mode per retry)
    const subprocessEnv = buildSubprocessEnv();
    const env = requestOptions?.env ? { ...subprocessEnv, ...requestOptions.env } : subprocessEnv;

    // Apply nodeConfig translation once (deterministic, not retry-dependent)
    // We need a throwaway Options to extract warnings from applyNodeConfig,
    // then re-apply per attempt. But nodeConfig warnings are deterministic,
    // so we compute them once and yield them before the first attempt.
    let nodeConfigWarnings: ProviderWarning[] = [];
    if (requestOptions?.nodeConfig) {
      const tempOptions: Options = {} as Options;
      nodeConfigWarnings = await applyNodeConfig(tempOptions, requestOptions.nodeConfig, cwd);
    }

    // Yield provider warnings once before retries
    for (const warning of nodeConfigWarnings) {
      yield { type: 'system' as const, content: `⚠️ ${warning.message}` };
    }

    // Track the current attempt's controller so a single abort listener
    // can forward cancellation without accumulating per-retry listeners.
    let currentController: AbortController | undefined;
    const onAbort = (): void => {
      currentController?.abort();
    };
    if (requestOptions?.abortSignal) {
      requestOptions.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const stderrLines: string[] = [];
      const toolResultQueue: ToolResultEntry[] = [];
      const controller = new AbortController();
      currentController = controller;

      // 1. Build SDK options (env pre-computed above)
      const options = buildBaseClaudeOptions(
        cwd,
        requestOptions,
        assistantDefaults,
        controller,
        stderrLines,
        toolResultQueue,
        env
      );

      // 2. Apply nodeConfig translation (re-applied per attempt since options are fresh)
      if (requestOptions?.nodeConfig) {
        await applyNodeConfig(options, requestOptions.nodeConfig, cwd);
      }

      // 3. Set session resume
      if (resumeSessionId) {
        options.resume = resumeSessionId;
        getLog().debug(
          { sessionId: resumeSessionId, forkSession: requestOptions?.forkSession },
          'resuming_session'
        );
      } else {
        getLog().debug({ cwd, attempt }, 'starting_new_session');
      }

      try {
        // 4. Run query with first-event timeout protection
        const rawEvents = query({ prompt, options });
        const timeoutMs = getFirstEventTimeoutMs();
        const diagnostics = buildFirstEventHangDiagnostics(
          options.env as Record<string, string>,
          options.model
        );
        const events = withFirstMessageTimeout(rawEvents, controller, timeoutMs, diagnostics);

        // 5. Stream normalized events
        yield* streamClaudeMessages(events, toolResultQueue);
        return;
      } catch (error) {
        const err = error as Error;
        const { enrichedError, errorClass, shouldRetry } = classifyAndEnrichError(
          err,
          stderrLines,
          controller
        );

        getLog().error(
          {
            err,
            stderrContext: stderrLines.join('\n'),
            errorClass,
            attempt,
            maxRetries: MAX_SUBPROCESS_RETRIES,
          },
          'query_error'
        );

        if (!shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) {
          throw enrichedError;
        }

        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs, errorClass }, 'retrying_subprocess');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = enrichedError;
      }
    }

    throw lastError ?? new Error('Claude Code query failed after retries');
  }

  getType(): string {
    return 'claude';
  }
}
