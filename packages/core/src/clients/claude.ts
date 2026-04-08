/**
 * Claude Agent SDK wrapper
 * Provides async generator interface for streaming Claude responses
 *
 * Type Safety Pattern:
 * - Uses `Options` type from SDK for query configuration
 * - SDK message types (SDKMessage, SDKAssistantMessage, etc.) have strict
 *   type checking that requires explicit type handling for content blocks
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
import {
  type AssistantRequestOptions,
  type IAssistantClient,
  type MessageChunk,
  type TokenUsage,
} from '../types';
import { createLogger } from '@archon/paths';
import { buildCleanSubprocessEnv } from '../utils/env-allowlist';
import { scanPathForSensitiveKeys, EnvLeakError } from '../utils/env-leak-scanner';
import * as codebaseDb from '../db/codebases';
import { loadConfig } from '../config/config-loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.claude');
  return cachedLog;
}

/**
 * Content block type for assistant messages
 * Represents text or tool_use blocks from Claude API responses
 */
interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** Stable Anthropic `tool_use_id` — used to pair `tool_call`/`tool_result` events. */
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
 * Build environment for Claude subprocess
 *
 * Auth behavior:
 * - CLAUDE_USE_GLOBAL_AUTH=true: Filter tokens, use global auth from `claude /login`
 * - CLAUDE_USE_GLOBAL_AUTH=false: Pass tokens through explicitly
 * - Not set: Auto-detect — use explicit tokens if present, otherwise fall back to global auth
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const globalAuthSetting = process.env.CLAUDE_USE_GLOBAL_AUTH?.toLowerCase();

  // Check for empty token values (common misconfiguration)
  const tokenVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY'] as const;
  const emptyTokens = tokenVars.filter(v => process.env[v] === '');
  if (emptyTokens.length > 0) {
    getLog().warn({ emptyTokens }, 'empty_token_values');
  }

  // Warn if user has the legacy variable but not the new ones
  if (
    process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    !process.env.CLAUDE_API_KEY
  ) {
    getLog().warn(
      { hint: 'Use CLAUDE_API_KEY or CLAUDE_CODE_OAUTH_TOKEN instead' },
      'deprecated_anthropic_api_key_ignored'
    );
  }

  const hasExplicitTokens = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_API_KEY
  );

  // Determine whether to use global auth
  let useGlobalAuth: boolean;
  if (globalAuthSetting === 'true') {
    useGlobalAuth = true;
    getLog().info({ authMode: 'global' }, 'using_global_auth');
  } else if (globalAuthSetting === 'false') {
    useGlobalAuth = false;
    getLog().info({ authMode: 'explicit' }, 'using_explicit_tokens');
  } else if (globalAuthSetting !== undefined) {
    // Unrecognized value - warn and fall back to auto-detect
    getLog().warn({ value: globalAuthSetting }, 'unrecognized_global_auth_setting');
    useGlobalAuth = !hasExplicitTokens;
  } else {
    // Not set - auto-detect: use tokens if present, otherwise global auth
    useGlobalAuth = !hasExplicitTokens;
    if (hasExplicitTokens) {
      getLog().info({ authMode: 'explicit', autoDetected: true }, 'using_explicit_tokens');
    } else {
      getLog().info({ authMode: 'global', autoDetected: true }, 'using_global_auth');
    }
  }

  let baseEnv: NodeJS.ProcessEnv;

  if (useGlobalAuth) {
    // Start from allowlist-filtered env, then strip auth tokens
    const clean = buildCleanSubprocessEnv();
    const { CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_API_KEY, ...envWithoutAuth } = clean;

    // Log if we're filtering out tokens (helps debug auth issues)
    const filtered = [
      CLAUDE_CODE_OAUTH_TOKEN && 'CLAUDE_CODE_OAUTH_TOKEN',
      CLAUDE_API_KEY && 'CLAUDE_API_KEY',
    ].filter(Boolean);

    if (filtered.length > 0) {
      getLog().info({ filteredVars: filtered }, 'global_auth_filtered_tokens');
    }

    baseEnv = envWithoutAuth;
  } else {
    // Start from allowlist-filtered env (includes auth tokens)
    baseEnv = buildCleanSubprocessEnv();
  }

  // Clean env vars that interfere with Claude Code subprocess
  const cleanedVars: string[] = [];

  // Strip nested-session guard marker (claude-code v2.1.41+).
  // When the server is started from inside a Claude Code terminal, CLAUDECODE=1
  // is inherited and causes the subprocess to refuse to launch.
  // See: https://github.com/anthropics/claude-code/issues/25434
  if (baseEnv.CLAUDECODE) {
    delete baseEnv.CLAUDECODE;
    cleanedVars.push('CLAUDECODE');
  }

  // Strip debugger env vars
  // See: https://github.com/anthropics/claude-code/issues/4619
  if (baseEnv.NODE_OPTIONS) {
    delete baseEnv.NODE_OPTIONS;
    cleanedVars.push('NODE_OPTIONS');
  }
  if (baseEnv.VSCODE_INSPECTOR_OPTIONS) {
    delete baseEnv.VSCODE_INSPECTOR_OPTIONS;
    cleanedVars.push('VSCODE_INSPECTOR_OPTIONS');
  }
  if (cleanedVars.length > 0) {
    getLog().info({ cleanedVars }, 'subprocess_env_cleaned');
  }

  return baseEnv;
}

/** Max retries for transient subprocess failures (3 = 4 total attempts).
 *  SDK subprocess crashes (exit code 1) are often intermittent — AJV schema validation
 *  regressions, stale HTTP/2 connections, and other transient SDK issues typically
 *  succeed on retry 3 or 4. See: anthropics/claude-code#22973, claude-code-action#853 */
const MAX_SUBPROCESS_RETRIES = 3;

/** Delay between retries in milliseconds */
const RETRY_BASE_DELAY_MS = 2000;

/** Patterns indicating rate limiting in stderr/error messages */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];

/** Patterns indicating auth issues in stderr/error messages */
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];

/** Patterns indicating the subprocess crashed (transient, worth retrying) */
const SUBPROCESS_CRASH_PATTERNS = [
  'exited with code',
  'killed',
  'signal',
  // "Operation aborted" can appear when the SDK's PostToolUse hook tries to write()
  // back to a subprocess pipe that was closed by an abort signal. This is a race
  // condition in SDK cleanup — safe to classify as a crash and retry.
  'operation aborted',
];

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
 * Returns the current process UID, or undefined on platforms that don't support it (e.g. Windows).
 * Exported for testing — spyOn(claudeModule, 'getProcessUid') works cross-platform.
 */
export function getProcessUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Claude AI assistant client
 * Implements generic IAssistantClient interface
 */
export class ClaudeClient implements IAssistantClient {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    // Claude Code SDK silently rejects bypassPermissions when running as root (UID 0).
    // Check once at construction time so the error surfaces early, not on first query.
    // IS_SANDBOX=1 bypasses this check — the SDK itself honours this env var in sandboxed
    // environments (Docker, VPS, CI) where running as root is expected.
    if (getProcessUid() === 0 && process.env.IS_SANDBOX !== '1') {
      throw new Error(
        'Claude Code SDK does not support bypassPermissions when running as root (UID 0). ' +
          'Run as a non-root user, set IS_SANDBOX=1, or use the Dockerfile which creates a non-root appuser.'
      );
    }
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  /**
   * Send a query to Claude and stream responses.
   * Includes retry logic for transient failures (up to 3 retries with exponential backoff).
   * Enriches errors with stderr context and classification.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // Pre-spawn: check for env key leak if codebase is not explicitly consented.
    // Use prefix lookup so worktree paths (e.g. .../worktrees/feature-branch) still
    // match the registered source cwd (e.g. .../source).
    const codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
    if (!codebase?.allow_env_keys) {
      const merged = await loadConfig(cwd);
      if (!merged.allowTargetRepoKeys) {
        const report = scanPathForSensitiveKeys(cwd);
        if (report.findings.length > 0) {
          throw new EnvLeakError(report, 'spawn-existing');
        }
      }
    }

    // Note: If subprocess crashes mid-stream after yielding chunks, those chunks
    // are already consumed by the caller. Retry starts a fresh subprocess, so the
    // caller may receive partial output from the failed attempt followed by full
    // output from the retry. This is a known limitation of async generator retries.
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      // Check if already aborted before starting attempt
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const stderrLines: string[] = [];
      const toolResultQueue: { toolName: string; toolOutput: string; toolCallId?: string }[] = [];

      // Create per-attempt abort controller and wire to caller's signal
      const controller = new AbortController();
      if (requestOptions?.abortSignal) {
        requestOptions.abortSignal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true }
        );
      }

      const options: Options = {
        cwd,
        env: requestOptions?.env
          ? { ...buildSubprocessEnv(), ...requestOptions.env }
          : buildSubprocessEnv(),
        model: requestOptions?.model,
        abortController: controller,
        ...(requestOptions?.tools !== undefined ? { tools: requestOptions.tools } : {}),
        ...(requestOptions?.disallowedTools !== undefined
          ? { disallowedTools: requestOptions.disallowedTools }
          : {}),
        // Pass outputFormat for json_schema structured output (Claude Agent SDK v0.2.45+)
        ...(requestOptions?.outputFormat !== undefined
          ? { outputFormat: requestOptions.outputFormat }
          : {}),
        // Note: hooks are merged below (line with `hooks: { ... }`) — not spread here
        // Pass MCP servers for per-node MCP support (Claude Agent SDK v0.2.74+)
        ...(requestOptions?.mcpServers !== undefined
          ? { mcpServers: requestOptions.mcpServers }
          : {}),
        // Pass allowedTools for MCP tool wildcards (e.g., 'mcp__github__*')
        ...(requestOptions?.allowedTools !== undefined
          ? { allowedTools: requestOptions.allowedTools }
          : {}),
        // Pass agents/agent for per-node skill scoping via AgentDefinition wrapping
        ...(requestOptions?.agents !== undefined ? { agents: requestOptions.agents } : {}),
        ...(requestOptions?.agent !== undefined ? { agent: requestOptions.agent } : {}),
        // Skip writing session transcripts to ~/.claude/projects/ — Archon manages its own
        // session persistence. persistSession: false reduces disk I/O and keeps the session
        // directory clean. Claude Agent SDK v0.2.74+.
        ...(requestOptions?.persistSession !== undefined
          ? { persistSession: requestOptions.persistSession }
          : {}),
        // When forkSession is true, the SDK copies the prior session's history into a new
        // session file, leaving the original untouched — safe to use on retries.
        ...(requestOptions?.forkSession !== undefined
          ? { forkSession: requestOptions.forkSession }
          : {}),
        // Forward Claude-only SDK options (effort, thinking, maxBudgetUsd, fallbackModel, betas, sandbox)
        ...(requestOptions?.effort !== undefined ? { effort: requestOptions.effort } : {}),
        ...(requestOptions?.thinking !== undefined ? { thinking: requestOptions.thinking } : {}),
        ...(requestOptions?.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: requestOptions.maxBudgetUsd }
          : {}),
        ...(requestOptions?.fallbackModel !== undefined
          ? { fallbackModel: requestOptions.fallbackModel }
          : {}),
        // betas: string[] from user config; SDK expects SdkBeta[] (string literal union).
        // User-provided values are validated upstream — cast is safe.
        ...(requestOptions?.betas !== undefined
          ? { betas: requestOptions.betas as Options['betas'] }
          : {}),
        ...(requestOptions?.sandbox !== undefined ? { sandbox: requestOptions.sandbox } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: requestOptions?.systemPrompt ?? { type: 'preset', preset: 'claude_code' },
        settingSources: requestOptions?.settingSources ?? ['project'],
        // Merge user-provided hooks with our PostToolUse capture hook
        hooks: {
          ...(requestOptions?.hooks ?? {}),
          PostToolUse: [
            ...((requestOptions?.hooks?.PostToolUse ?? []) as HookCallbackMatcher[]),
            {
              hooks: [
                (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
                  const toolName = (input as { tool_name?: string }).tool_name ?? 'unknown';
                  const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
                  const toolResponse = (input as { tool_response?: unknown }).tool_response;
                  const output =
                    typeof toolResponse === 'string'
                      ? toolResponse
                      : JSON.stringify(toolResponse ?? '');
                  // Truncate large outputs (e.g., file reads) to prevent DB bloat
                  const maxLen = 10_000;
                  toolResultQueue.push({
                    toolName,
                    toolOutput: output.length > maxLen ? output.slice(0, maxLen) + '...' : output,
                    ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}),
                  });
                  return { continue: true };
                }) as HookCallback,
              ],
            },
          ],
          // Without this, errored / interrupted / permission-denied tools never produce
          // a paired tool_result chunk and the corresponding UI card spins forever.
          // SDK type: PostToolUseFailureHookInput { tool_name, tool_use_id, error, is_interrupt? }
          PostToolUseFailure: [
            ...((requestOptions?.hooks?.PostToolUseFailure ?? []) as HookCallbackMatcher[]),
            {
              hooks: [
                (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
                  // Always return { continue: true } even on internal errors so a
                  // malformed SDK payload can never crash the hook dispatch silently.
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
        },
        stderr: (data: string) => {
          const output = data.trim();
          if (!output) return;

          // Always capture stderr for diagnostics — previous filtering discarded
          // useful SDK startup output, leaving stderrContext empty on crashes.
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
        for await (const msg of query({ prompt, options })) {
          // Drain tool results captured by PostToolUse hook before processing the next message
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

          if (msg.type === 'assistant') {
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
          } else if (msg.type === 'system') {
            // Check MCP server connection status from system/init
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
          } else if (msg.type === 'rate_limit_event') {
            const rateLimitMsg = msg as { rate_limit_info?: Record<string, unknown> };
            getLog().warn(
              { rateLimitInfo: rateLimitMsg.rate_limit_info },
              'claude.rate_limit_event'
            );
            yield { type: 'rate_limit', rateLimitInfo: rateLimitMsg.rate_limit_info ?? {} };
          } else if (msg.type === 'result') {
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
        // Drain any remaining tool results from the hook queue.
        // Must mirror the in-loop drain — PostToolUseFailure results commonly land
        // here (they fire just before the SDK's terminal `result` message), so
        // dropping toolCallId here would defeat the stable-pairing fix.
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
        return; // Success - exit retry loop
      } catch (error) {
        const err = error as Error;

        // Don't retry aborted queries
        if (controller.signal.aborted) {
          throw new Error('Query aborted');
        }

        const stderrContext = stderrLines.join('\n');
        const errorClass = classifySubprocessError(err.message, stderrContext);

        getLog().error(
          { err, stderrContext, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        // Don't retry auth errors - they won't resolve
        if (errorClass === 'auth') {
          const enrichedError = new Error(
            `Claude Code auth error: ${err.message}${stderrContext ? ` (${stderrContext})` : ''}`
          );
          enrichedError.cause = error;
          throw enrichedError;
        }

        // Retry transient failures (rate limit, crash)
        if (
          attempt < MAX_SUBPROCESS_RETRIES &&
          (errorClass === 'rate_limit' || errorClass === 'crash')
        ) {
          const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_subprocess');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        // Final failure - enrich and throw
        const enrichedMessage = stderrContext
          ? `Claude Code ${errorClass}: ${err.message} (stderr: ${stderrContext})`
          : `Claude Code ${errorClass}: ${err.message}`;
        const enrichedError = new Error(enrichedMessage);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    // Should not reach here, but handle defensively
    throw lastError ?? new Error('Claude Code query failed after retries');
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'claude';
  }
}
