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
 * - Credentials reach the subprocess via process.env (already cleaned by
 *   stripCwdEnv) PLUS any per-request `requestOptions.env` (per-user delivered
 *   keys/subscriptions), merged LAST so it wins. `buildSubprocessEnv` does NOT
 *   filter tokens — it only logs which posture process.env shows (explicit
 *   token present vs not); the historical env-token allowlist was removed in
 *   #1067, so the log can read "global" while a per-request token authenticates.
 * - CLAUDE_USE_GLOBAL_AUTH is an Archon-only boot sentinel (set for solo
 *   installs with no creds — see server/src/boot/claude-auth-posture.ts). The
 *   Claude CLI itself ignores it; it neither gates nor filters env here.
 *
 * Binary resolution:
 * - In compiled binaries, `pathToClaudeCodeExecutable` is resolved from
 *   `CLAUDE_BIN_PATH` env or `assistants.claude.claudeBinaryPath` config;
 *   see ./binary-resolver.ts. In dev mode the resolver returns undefined
 *   and the SDK picks its bundled per-platform native binary (Mach-O/ELF/PE
 *   from `@anthropic-ai/claude-agent-sdk-<platform>` optional dep). Pre-0.2.x
 *   SDKs shipped `cli.js` in the package and dev mode resolved that JS file;
 *   the SDK switched to native binaries in the 0.2.x series. See
 *   `shouldPassNoEnvFile` for the implications on the `--no-env-file` flag.
 */
import {
  query,
  type Options,
  type HookCallback,
  type HookCallbackMatcher,
  type SDKAssistantMessageError,
} from '@anthropic-ai/claude-agent-sdk';
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
import { resolveClaudeBinaryPath } from './binary-resolver';
import { buildArchonMcpServer, ARCHON_TOOL_SERVER } from './native-tools';
import { createLogger } from '@archon/paths';
import { loadMcpConfig } from '../mcp/config';
import { withResumedOutcome, resumedOutcome } from '../shared/resumed';

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
  // Using || intentionally: empty string should be treated as missing credential
  const hasExplicitTokens = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_API_KEY
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

/**
 * The Claude Code SDK surfaces API-level failures (auth not configured,
 * invalid key, billing, rate limit, model errors) as TEXT rather than
 * throwing: it synthesizes an assistant message (`message.model:
 * '<synthetic>'`, wrapper `error: SDKAssistantMessageError`) whose content is
 * the error prose, then emits a result with `subtype: 'success'` and
 * `is_error: true` — the same field pair as the legitimate stop-sequence
 * termination carve-out (#1425). Without structural detection the error prose
 * flows downstream as successful node output (#1797).
 *
 * This error carries the SDK's typed error code so retry classification is
 * structural — never matched against the message text.
 */
export class ClaudeApiResultError extends Error {
  readonly sdkErrorCode: SDKAssistantMessageError | 'unknown';

  constructor(sdkErrorCode: SDKAssistantMessageError | 'unknown', resultText: string) {
    super(`Claude API error (${sdkErrorCode}): ${resultText}`);
    this.name = 'ClaudeApiResultError';
    this.sdkErrorCode = sdkErrorCode;
  }
}

/**
 * Map the SDK's typed assistant-message error code onto the existing
 * subprocess retry classes. Auth-shaped codes are non-retryable (operator
 * must fix credentials); transient API states reuse the existing
 * rate_limit/crash backoff. Everything else is 'unknown' — fail fast rather
 * than retry blindly.
 */
function classifySdkErrorCode(
  code: SDKAssistantMessageError | 'unknown'
): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
      return 'auth';
    case 'rate_limit':
    case 'overloaded':
      return 'rate_limit';
    case 'server_error':
      return 'crash';
    default:
      return 'unknown';
  }
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
      if (!options.hooks) {
        (options as Record<string, unknown>).hooks = {};
      }
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
    const agentDef: {
      description: string;
      prompt: string;
      skills: string[];
      tools?: string[];
      model?: string;
    } = {
      description: 'DAG node with skills',
      prompt: `You have preloaded skills: ${skills.join(', ')}. Use them when relevant.`,
      skills,
    };
    if (options.tools) {
      agentDef.tools = [...(options.tools as string[]), 'Skill'];
    }
    if (options.model) agentDef.model = options.model;
    options.agents = { [agentId]: agentDef };
    options.agent = agentId;
    if (!options.allowedTools?.includes('Skill')) {
      options.allowedTools = [...(options.allowedTools ?? []), 'Skill'];
    }
    getLog().info({ skills, agentId }, 'claude.skills_agent_created');
  }

  // agents → inline AgentDefinition pass-through.
  // Runs AFTER skills: so user-defined agents win on ID collision with
  // the internal 'dag-node-skills' wrapper.
  // options.agent is intentionally left alone — inline agents are sub-agents
  // invokable via the Task tool, not the primary agent for the query.
  if (nodeConfig.agents) {
    // Warn loudly when a user-defined agent overrides the internal
    // 'dag-node-skills' wrapper set by the skills: block above. The
    // merge is by design (user wins) but silent capability removal
    // is the exact failure mode we want to avoid.
    if (
      Object.hasOwn(nodeConfig.agents, 'dag-node-skills') &&
      options.agents?.['dag-node-skills'] !== undefined
    ) {
      getLog().warn(
        { nodeSkills: nodeConfig.skills ?? [] },
        'claude.inline_agents_override_skills_wrapper'
      );
    }
    options.agents = {
      ...(options.agents ?? {}),
      ...(nodeConfig.agents as NonNullable<Options['agents']>),
    };
    getLog().info({ agentIds: Object.keys(nodeConfig.agents) }, 'claude.inline_agents_registered');
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

  // Phase 4 of #975 — enable AI-generated progress summaries for subagents
  // spawned by workflow nodes. Without this, `task_progress` events arrive
  // every ~30s with just `description` + `last_tool_name`; with it, the SDK
  // forks the subagent's session every ~30s to produce a short present-tense
  // `summary` (e.g. "Analyzing auth module"). The fork reuses the subagent's
  // model + prompt cache, so cost stays minimal. Only workflow nodes opt in —
  // direct chat calls (no nodeConfig) skip this to keep the chat surface
  // unchanged. Authors can still override per-node by setting
  // `agentProgressSummaries: false` in nodeConfig (see below).
  if (nodeConfig.agentProgressSummaries !== undefined) {
    options.agentProgressSummaries = nodeConfig.agentProgressSummaries;
  } else {
    options.agentProgressSummaries = true;
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

/** Bun-runnable JS extensions. `.ts`/`.tsx`/`.jsx` are excluded — the SDK has
 * never shipped those as entry points, so accepting them would only widen the
 * surface for misconfiguration. */
const BUN_JS_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

/**
 * Decide whether the Claude subprocess should be spawned with `--no-env-file`.
 *
 * `--no-env-file` is a Bun flag (consumed by the Bun runtime, not by Claude
 * Code itself) that prevents auto-loading `.env` from the target repo cwd
 * into the spawned process. It only does anything when the SDK spawns a
 * Bun-runnable JS file via `bun cli.js …` — Bun parses the flag and skips
 * its env autoload. For native Claude Code binaries the flag is meaningless
 * and, worse, gets handed to the binary which rejects unknown options.
 *
 * The dev-mode `cliPath === undefined` path used to imply "JS executable"
 * because the SDK shipped `cli.js` inside its package. SDK 0.2.x switched
 * to per-platform native binaries (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`),
 * so dev mode now resolves to a native executable and the historical
 * `undefined → true` heuristic is unsafe. Only return `true` when we have
 * an explicit Bun-runnable JS path (`.js`/`.mjs`/`.cjs`) — i.e. when the
 * operator pointed Archon at a legacy Bun/Node-runnable cli script.
 * Otherwise return `false`.
 *
 * Safety: target-repo `.env` leaks are prevented by `stripCwdEnv()` in
 * `@archon/paths` (#1067), which deletes CWD `.env` keys from
 * `process.env` at every Archon entry point before any subprocess is
 * spawned. The native Claude binary does not auto-load `.env` from its
 * cwd either (verified end-to-end with sentinel keys). `--no-env-file`
 * was belt-and-suspenders for the JS-via-Bun case only.
 *
 * Exported so the decision can be unit-tested without needing to mock
 * `BUNDLED_IS_BINARY` or run the full provider sendQuery pathway.
 */
export function shouldPassNoEnvFile(cliPath: string | undefined): boolean {
  if (cliPath === undefined) return false;
  return BUN_JS_EXTENSIONS.some(ext => cliPath.endsWith(ext));
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
  env: NodeJS.ProcessEnv,
  cliPath: string | undefined
): Options {
  const isJsExecutable = shouldPassNoEnvFile(cliPath);
  getLog().debug({ cliPath: cliPath ?? null, isJsExecutable }, 'claude.subprocess_env_file_flag');

  return {
    cwd,
    // In compiled binaries, the resolver supplies an absolute executable path;
    // in dev mode it returns undefined and the SDK resolves from node_modules.
    ...(cliPath !== undefined ? { pathToClaudeCodeExecutable: cliPath } : {}),
    ...(isJsExecutable ? { executableArgs: ['--no-env-file'] } : {}),
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
    settingSources: assistantDefaults.settingSources ?? ['project', 'user'],
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
  // Synthetic error message recorded while waiting for the terminal result to
  // confirm it (#1797). Detection is two-signal: the typed wrapper `error`
  // field on a '<synthetic>' assistant message, then `is_error: true` on the
  // result. See ClaudeApiResultError.
  let pendingSdkError: { code: SDKAssistantMessageError; text: string } | undefined;

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
      const message = msg as {
        message: { content: ContentBlock[]; model?: string };
        error?: SDKAssistantMessageError;
      };
      const content = message.message.content;

      // API-level failure surfaced as text (#1797): the SDK writes the error
      // prose into a synthesized assistant message instead of throwing. Both
      // signals are required — a REAL model message can carry an error code
      // too (e.g. 'max_output_tokens' on truncated output) and its content
      // must flow through untouched; only '<synthetic>' content is
      // SDK-generated error prose, never model output.
      if (message.error !== undefined && message.message.model === '<synthetic>') {
        const text = content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text)
          .join('\n');
        pendingSdkError = { code: message.error, text };
        getLog().warn({ errorCode: message.error, text }, 'claude.synthetic_error_message');
        // Withhold the error prose from the output stream — yielding it is
        // what poisons downstream $node.output. If the terminal result
        // contradicts (no is_error), the text is yielded late as a fail-safe.
        continue;
      }

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
        // Subagent task lifecycle (Claude SDK v0.2.89+)
        task_id?: string;
        tool_use_id?: string;
        description?: string;
        task_type?: string;
        prompt?: string;
        summary?: string;
        usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
        last_tool_name?: string;
        status?: string;
        output_file?: string;
        skip_transcript?: boolean;
        // Hook lifecycle (Claude SDK v0.2.89+)
        hook_id?: string;
        hook_name?: string;
        hook_event?: string;
        outcome?: 'success' | 'error' | 'cancelled';
        exit_code?: number;
      };
      const subtype = sysMsg.subtype;
      if (subtype === 'init' && sysMsg.mcp_servers) {
        const failed = sysMsg.mcp_servers.filter(s => s.status !== 'connected');
        if (failed.length > 0) {
          const names = failed.map(s => `${s.name} (${s.status})`).join(', ');
          yield { type: 'system', content: `MCP server connection failed: ${names}` };
        }
      } else if (subtype === 'task_started' && sysMsg.task_id) {
        // Ambient / housekeeping tasks (SDK signals via skip_transcript) are
        // SDK-internal — they bloat the Web UI's tasks panel without telling
        // the user anything actionable. Drop them at the provider boundary;
        // the workflow executor and SSE bridge never see them.
        if (sysMsg.skip_transcript === true) {
          getLog().debug(
            { taskId: sysMsg.task_id, taskType: sysMsg.task_type },
            'claude.task_started_housekeeping_suppressed'
          );
        } else {
          yield {
            type: 'task_started',
            taskId: sysMsg.task_id,
            description: sysMsg.description ?? '',
            ...(sysMsg.task_type !== undefined ? { taskType: sysMsg.task_type } : {}),
            ...(sysMsg.prompt !== undefined ? { prompt: sysMsg.prompt } : {}),
            ...(sysMsg.tool_use_id !== undefined ? { toolUseId: sysMsg.tool_use_id } : {}),
          };
        }
      } else if (subtype === 'task_progress' && sysMsg.task_id) {
        yield {
          type: 'task_progress',
          taskId: sysMsg.task_id,
          description: sysMsg.description ?? '',
          ...(sysMsg.summary !== undefined ? { summary: sysMsg.summary } : {}),
          ...(sysMsg.usage !== undefined ? { usage: sysMsg.usage } : {}),
          ...(sysMsg.last_tool_name !== undefined ? { lastToolName: sysMsg.last_tool_name } : {}),
          ...(sysMsg.tool_use_id !== undefined ? { toolUseId: sysMsg.tool_use_id } : {}),
        };
      } else if (subtype === 'task_notification' && sysMsg.task_id) {
        const status = sysMsg.status;
        if (status !== 'completed' && status !== 'failed' && status !== 'stopped') {
          getLog().warn(
            { taskId: sysMsg.task_id, status },
            'claude.task_notification_unknown_status'
          );
          // Fall through with raw status to avoid dropping the event entirely
        }
        yield {
          type: 'task_notification',
          taskId: sysMsg.task_id,
          status:
            status === 'completed' || status === 'failed' || status === 'stopped'
              ? status
              : 'stopped',
          summary: sysMsg.summary ?? '',
          outputFile: sysMsg.output_file ?? '',
          ...(sysMsg.usage !== undefined ? { usage: sysMsg.usage } : {}),
          ...(sysMsg.tool_use_id !== undefined ? { toolUseId: sysMsg.tool_use_id } : {}),
        };
      } else if (subtype === 'hook_started' && sysMsg.hook_id) {
        yield {
          type: 'hook_started',
          hookId: sysMsg.hook_id,
          hookName: sysMsg.hook_name ?? '',
          hookEvent: sysMsg.hook_event ?? '',
        };
      } else if (subtype === 'hook_response' && sysMsg.hook_id) {
        const outcome = sysMsg.outcome;
        yield {
          type: 'hook_response',
          hookId: sysMsg.hook_id,
          hookName: sysMsg.hook_name ?? '',
          hookEvent: sysMsg.hook_event ?? '',
          outcome:
            outcome === 'success' || outcome === 'error' || outcome === 'cancelled'
              ? outcome
              : 'error',
          ...(sysMsg.exit_code !== undefined ? { exitCode: sysMsg.exit_code } : {}),
        };
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
        errors?: string[];
        result?: string;
        terminal_reason?: string;
        api_error_status?: number | null;
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
      // The terminal result resolves any recorded synthetic error message.
      const syntheticError = pendingSdkError;
      pendingSdkError = undefined;
      const tokens = normalizeClaudeUsage(resultMsg.usage);
      const sdkErrors = Array.isArray(resultMsg.errors) ? resultMsg.errors : undefined;

      // `is_error: true` + `subtype: 'success'` is ambiguous: it is BOTH the
      // SDK's stop-sequence termination encoding (#1425, a legitimate success)
      // AND its API-failure-as-text encoding (#1797 — auth/billing/rate-limit
      // errors that even set stop_reason: 'stop_sequence'). Disambiguate
      // structurally: a preceding synthetic error message (primary, typed
      // signal), or terminal_reason 'api_error' (secondary — observed at
      // runtime on API failures but not yet in the SDK's TerminalReason d.ts
      // union), marks a real failure. Throw so callers fail the node/turn
      // instead of consuming error prose as successful output.
      if (
        resultMsg.is_error === true &&
        resultMsg.subtype === 'success' &&
        (syntheticError !== undefined || resultMsg.terminal_reason === 'api_error')
      ) {
        const code = syntheticError?.code ?? 'unknown';
        const text =
          syntheticError?.text ||
          resultMsg.result ||
          sdkErrors?.join('; ') ||
          'API error result with no error text';
        getLog().error(
          {
            sessionId: resultMsg.session_id,
            errorCode: code,
            terminalReason: resultMsg.terminal_reason,
            apiErrorStatus: resultMsg.api_error_status,
            text,
          },
          'claude.result_api_error'
        );
        throw new ClaudeApiResultError(code, text);
      }

      // Fail-safe (never observed in practice): a synthetic error message
      // followed by a non-error result. Yield the withheld text late rather
      // than silently swallowing content.
      if (syntheticError !== undefined && resultMsg.is_error !== true) {
        getLog().warn(
          { sessionId: resultMsg.session_id, errorCode: syntheticError.code },
          'claude.synthetic_error_not_confirmed'
        );
        yield { type: 'assistant', content: syntheticError.text };
      }

      // SDKResultSuccess declares `is_error: boolean` (not literal false). When a
      // model terminates via a configured stop sequence (stop_reason ===
      // 'stop_sequence') the SDK can set is_error: true while keeping
      // subtype: 'success' — its encoding of "non-default termination, not a
      // failure". Treat that pair as a clean success so downstream consumers
      // (which gate failure on isError) don't misclassify it.
      const isRealError = resultMsg.is_error === true && resultMsg.subtype !== 'success';
      if (isRealError) {
        getLog().error(
          {
            sessionId: resultMsg.session_id,
            errorSubtype: resultMsg.subtype,
            stopReason: resultMsg.stop_reason,
            errors: sdkErrors,
          },
          'claude.result_is_error'
        );
      } else if (resultMsg.is_error === true && resultMsg.subtype === 'success') {
        getLog().debug(
          {
            sessionId: resultMsg.session_id,
            stopReason: resultMsg.stop_reason,
          },
          'claude.result_success_validated'
        );
      }
      yield {
        type: 'result',
        sessionId: resultMsg.session_id,
        ...(tokens ? { tokens } : {}),
        ...(resultMsg.structured_output !== undefined
          ? { structuredOutput: resultMsg.structured_output }
          : {}),
        ...(isRealError ? { isError: true, errorSubtype: resultMsg.subtype } : {}),
        ...(isRealError && sdkErrors?.length ? { errors: sdkErrors } : {}),
        ...(resultMsg.total_cost_usd !== undefined ? { cost: resultMsg.total_cost_usd } : {}),
        ...(resultMsg.stop_reason != null ? { stopReason: resultMsg.stop_reason } : {}),
        ...(resultMsg.num_turns !== undefined ? { numTurns: resultMsg.num_turns } : {}),
        ...(resultMsg.model_usage
          ? { modelUsage: resultMsg.model_usage as Record<string, unknown> }
          : {}),
      };
    }
  }

  // Stream ended after a synthetic error message with no terminal result to
  // confirm or contradict it. A dangling synthetic error is a failure — the
  // SDK ends every turn with a result, so this is an abnormal end (#1797).
  if (pendingSdkError !== undefined) {
    getLog().error(
      { errorCode: pendingSdkError.code, text: pendingSdkError.text },
      'claude.synthetic_error_stream_ended'
    );
    throw new ClaudeApiResultError(pendingSdkError.code, pendingSdkError.text);
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

  // API failures the SDK surfaced as text (#1797) carry a typed error code —
  // classify by that code, never by matching the (arbitrary) message text.
  if (error instanceof ClaudeApiResultError) {
    const errorClass = classifySdkErrorCode(error.sdkErrorCode);
    return {
      enrichedError: error,
      errorClass,
      shouldRetry: errorClass === 'rate_limit' || errorClass === 'crash',
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

    // Resolve Claude CLI path once before the retry loop. In binary mode this
    // throws immediately if neither env nor config supplies a valid path, so
    // the user gets a clean error rather than N retries of "Module not found".
    const resolvedCliPath = await resolveClaudeBinaryPath(assistantDefaults.claudeBinaryPath);

    // Build subprocess env once (avoids re-logging auth mode per retry)
    const subprocessEnv = buildSubprocessEnv();
    const env = requestOptions?.env ? { ...subprocessEnv, ...requestOptions.env } : subprocessEnv;
    // CLAUDE_API_KEY is Archon's variable name; the Claude Code CLI only reads
    // ANTHROPIC_API_KEY, so mirror it or solo .env installs never authenticate
    // (delivery.ts sets both vars on the per-user api_key path). Guarded on the
    // MERGED env, not process.env: a per-request CLAUDE_CODE_OAUTH_TOKEN (per-user
    // subscription delivered via requestOptions.env) must stay authoritative —
    // the CLI prefers ANTHROPIC_API_KEY over the OAuth token, so injecting the
    // install key alongside it would silently rebill the run. Truthiness is
    // intentional: empty string = missing credential. Never clobbers an
    // explicit ANTHROPIC_API_KEY.
    if (env.CLAUDE_API_KEY && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
      env.ANTHROPIC_API_KEY = env.CLAUDE_API_KEY;
      getLog().debug('using_mirrored_api_key');
    }

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

      // 1. Build SDK options (env and cliPath pre-computed above)
      const options = buildBaseClaudeOptions(
        cwd,
        requestOptions,
        assistantDefaults,
        controller,
        stderrLines,
        toolResultQueue,
        env,
        resolvedCliPath
      );

      // 2. Apply nodeConfig translation (re-applied per attempt since options are fresh)
      if (requestOptions?.nodeConfig) {
        await applyNodeConfig(options, requestOptions.nodeConfig, cwd);
      }

      // 2b. Register in-process native tools (e.g. manage_run) as an archon MCP
      //     server, mirroring the file-based mcp branch. Merge so a nodeConfig
      //     mcp config and native tools can coexist.
      if (requestOptions?.nativeTools && requestOptions.nativeTools.length > 0) {
        const server = buildArchonMcpServer(requestOptions.nativeTools);
        options.mcpServers = { ...(options.mcpServers ?? {}), [ARCHON_TOOL_SERVER]: server };
        options.allowedTools = [...(options.allowedTools ?? []), `mcp__${ARCHON_TOOL_SERVER}__*`];
        getLog().info(
          { count: requestOptions.nativeTools.length },
          'claude.native_tools_registered'
        );
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
        // Claude resumes-or-errors: an invalid resume id throws (and is
        // retried/surfaced), so reaching the result stream means the prior
        // session was restored. Hence `true` whenever a resume was requested.
        yield* withResumedOutcome(
          streamClaudeMessages(events, toolResultQueue),
          resumedOutcome(resumeSessionId, true)
        );
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
