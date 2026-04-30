import {
  query as claudeQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "./events.js";

/**
 * Internal adapter wrapping the Claude Agent SDK `query()` API.
 *
 * Emits canonical snake_case `AgentEvent`s to match the symphoney-codex spec shape.
 * The SDK exposes one async-iterable per turn; we run one iterator per call:
 *   - `runFirstTurn()` starts a new session and captures `threadId` from `system.init`.
 *   - `runContinuationTurn()` resumes the existing thread via `options.resume`.
 *
 * Multi-turn lifecycle and workspace management live in the orchestrator — this
 * adapter only owns one turn at a time.
 */
export interface ClaudeAdapterOptions {
  cwd: string;
  /** Optional Claude model alias / id. */
  model?: string;
  /** Per-turn timeout (ms). Aborts the SDK query if exceeded. */
  turnTimeoutMs: number;
  /** Read timeout for the initial `system.init` signal on the first turn. */
  readTimeoutMs: number;
  /** Allow-list of tool names exposed to the agent. */
  allowedTools: string[];
  /** Optional in-process MCP server configs (e.g., linear_graphql). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission mode (default `bypassPermissions` for autonomous workspace runs). */
  permissionMode?: Options["permissionMode"];
  /** System prompt prepended to every turn. */
  systemPrompt?: string;
  /**
   * When true, scrub `ANTHROPIC_API_KEY` from the env passed to the SDK so it falls
   * back to the Claude Code OAuth credential (Claude Max / Pro subscription).
   */
  forceSubscriptionAuth?: boolean;
  /** Override for tests. */
  queryImpl?: typeof claudeQuery;
}

export interface AdapterTurnArgs {
  prompt: string;
  emit: (event: AgentEvent) => void;
  abort: AbortController;
}

export interface TurnOutcome {
  status: "completed" | "failed" | "timeout" | "cancelled";
  error?: string;
  numTurns: number;
  durationMs: number;
  /** SDK turn id (= SDKResultMessage.uuid). */
  turnId: string | null;
  /** Stable session id captured from the first system.init message. */
  threadId: string | null;
  /** Latest absolute usage snapshot, if the turn surfaced one. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

interface AdapterState {
  threadId: string;
  // Cumulative absolute totals. The SDK reports per-turn usage; we accumulate so the
  // orchestrator can compute monotonic deltas via its existing applyAgentEvent path.
  cumInputTokens: number;
  cumOutputTokens: number;
  cumTotalTokens: number;
  cumCacheCreation: number;
  cumCacheRead: number;
}

export class ClaudeAdapter {
  private readonly opts: ClaudeAdapterOptions;
  private readonly queryImpl: typeof claudeQuery;
  private state: AdapterState | null = null;

  constructor(opts: ClaudeAdapterOptions) {
    this.opts = opts;
    this.queryImpl = opts.queryImpl ?? claudeQuery;
  }

  async runFirstTurn(args: AdapterTurnArgs): Promise<TurnOutcome> {
    return this.runTurnInternal(args, /*resumeThreadId*/ null);
  }

  async runContinuationTurn(args: AdapterTurnArgs): Promise<TurnOutcome> {
    if (!this.state) {
      throw new Error("no live Claude session for continuation turn");
    }
    return this.runTurnInternal(args, this.state.threadId);
  }

  async stop(): Promise<void> {
    this.state = null;
  }

  private async runTurnInternal(
    args: AdapterTurnArgs,
    resumeThreadId: string | null,
  ): Promise<TurnOutcome> {
    const startMs = Date.now();
    const permissionMode = this.opts.permissionMode ?? "bypassPermissions";
    const options: Options = {
      cwd: this.opts.cwd,
      permissionMode,
      // NOTE: do not pin SDK `maxTurns` — it counts every model round-trip including
      // tool follow-ups. The orchestrator caps worker-level continuation turns via
      // `agent.max_turns`. The SDK ends naturally on a non-tool stopping message.
      allowedTools: this.opts.allowedTools,
      abortController: args.abort,
      // Empty `settingSources` keeps the workspace truly isolated — no leak from
      // user-level or project-level Claude Code settings.
      settingSources: [],
    };
    if (permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }
    if (this.opts.forceSubscriptionAuth) {
      const scrubbed: Record<string, string | undefined> = { ...process.env };
      delete scrubbed.ANTHROPIC_API_KEY;
      options.env = scrubbed;
    }
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.systemPrompt) options.systemPrompt = this.opts.systemPrompt;
    if (this.opts.mcpServers) options.mcpServers = this.opts.mcpServers;
    if (resumeThreadId) options.resume = resumeThreadId;

    let q: Query;
    try {
      q = this.queryImpl({ prompt: args.prompt, options });
    } catch (err) {
      const message = (err as Error).message;
      args.emit({
        event: "startup_failed",
        timestamp: nowIso(),
        message,
        codex_app_server_pid: null,
      });
      return { status: "failed", error: message, numTurns: 0, durationMs: 0, turnId: null, threadId: this.state?.threadId ?? null };
    }

    let timedOut = false;
    const turnTimer = setTimeout(() => {
      timedOut = true;
      try {
        args.abort.abort();
      } catch {
        // ignore
      }
    }, this.opts.turnTimeoutMs);
    if (typeof turnTimer.unref === "function") turnTimer.unref();

    let saw_init = false;
    let init_timer: NodeJS.Timeout | null = null;
    if (resumeThreadId === null) {
      init_timer = setTimeout(() => {
        if (saw_init) return;
        try {
          args.abort.abort();
        } catch {
          // ignore
        }
      }, this.opts.readTimeoutMs);
      if (typeof init_timer.unref === "function") init_timer.unref();
    }

    let lastResult: SDKResultMessage | null = null;
    args.emit({
      event: "turn_started",
      timestamp: nowIso(),
      thread_id: resumeThreadId,
      codex_app_server_pid: null,
    });

    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          saw_init = true;
          if (init_timer) clearTimeout(init_timer);
          if (!this.state) {
            this.state = {
              threadId: msg.session_id,
              cumInputTokens: 0,
              cumOutputTokens: 0,
              cumTotalTokens: 0,
              cumCacheCreation: 0,
              cumCacheRead: 0,
            };
          } else {
            this.state.threadId = msg.session_id;
          }
          args.emit({
            event: "session_started",
            timestamp: nowIso(),
            thread_id: msg.session_id,
            session_id: `${msg.session_id}-init`,
            codex_app_server_pid: null,
            raw: systemInitPayload(msg),
          });
        } else if (msg.type === "result") {
          lastResult = msg;
        } else if (msg.type === "assistant") {
          const summary = summarizeAssistant(msg);
          args.emit({
            event: "notification",
            timestamp: nowIso(),
            thread_id: this.state?.threadId ?? null,
            codex_app_server_pid: null,
            message: summary ?? null,
          });
        } else if (msg.type === "user") {
          args.emit({
            event: "other_message",
            timestamp: nowIso(),
            thread_id: this.state?.threadId ?? null,
            codex_app_server_pid: null,
            message: "user_input",
          });
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      const baseEvent = {
        timestamp: nowIso(),
        thread_id: this.state?.threadId ?? null,
        codex_app_server_pid: null,
      };
      if (timedOut) {
        args.emit({ ...baseEvent, event: "turn_failed", message: "turn_timeout" });
        return { status: "timeout", error: message, numTurns: 0, durationMs: Date.now() - startMs, turnId: null, threadId: this.state?.threadId ?? null };
      }
      if (args.abort.signal.aborted) {
        args.emit({ ...baseEvent, event: "turn_cancelled", message });
        return { status: "cancelled", error: message, numTurns: 0, durationMs: Date.now() - startMs, turnId: null, threadId: this.state?.threadId ?? null };
      }
      args.emit({ ...baseEvent, event: "turn_failed", message });
      return { status: "failed", error: message, numTurns: 0, durationMs: Date.now() - startMs, turnId: null, threadId: this.state?.threadId ?? null };
    } finally {
      clearTimeout(turnTimer);
      if (init_timer) clearTimeout(init_timer);
    }

    const baseEvent = {
      timestamp: nowIso(),
      thread_id: this.state?.threadId ?? null,
      codex_app_server_pid: null as number | null,
    };

    if (!lastResult) {
      args.emit({ ...baseEvent, event: "turn_failed", message: "no_result_message" });
      return { status: "failed", error: "no result message", numTurns: 0, durationMs: Date.now() - startMs, turnId: null, threadId: this.state?.threadId ?? null };
    }

    const turnUsage = readUsageFromResult(lastResult);
    let absoluteUsage:
      | {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
        }
      | undefined;
    if (turnUsage && this.state) {
      this.state.cumInputTokens += turnUsage.input;
      this.state.cumOutputTokens += turnUsage.output;
      this.state.cumTotalTokens += turnUsage.input + turnUsage.output;
      this.state.cumCacheCreation += turnUsage.cacheCreation;
      this.state.cumCacheRead += turnUsage.cacheRead;
      absoluteUsage = {
        input_tokens: this.state.cumInputTokens,
        output_tokens: this.state.cumOutputTokens,
        total_tokens: this.state.cumTotalTokens,
        cache_creation_input_tokens: this.state.cumCacheCreation,
        cache_read_input_tokens: this.state.cumCacheRead,
      };
    }

    if (lastResult.subtype === "success") {
      args.emit({
        ...baseEvent,
        event: "turn_completed",
        turn_id: lastResult.uuid,
        session_id: this.state ? `${this.state.threadId}-${lastResult.uuid}` : null,
        usage: absoluteUsage ?? null,
      });
      return {
        status: "completed",
        numTurns: lastResult.num_turns,
        durationMs: Date.now() - startMs,
        turnId: lastResult.uuid,
        threadId: this.state?.threadId ?? null,
        usage: absoluteUsage,
      };
    }

    args.emit({
      ...baseEvent,
      event: "turn_failed",
      turn_id: lastResult.uuid,
      session_id: this.state ? `${this.state.threadId}-${lastResult.uuid}` : null,
      message: lastResult.subtype,
      usage: absoluteUsage ?? null,
    });
    return {
      status: "failed",
      error: lastResult.subtype,
      numTurns: lastResult.num_turns,
      durationMs: Date.now() - startMs,
      turnId: lastResult.uuid,
      threadId: this.state?.threadId ?? null,
      usage: absoluteUsage,
    };
  }
}

function readUsageFromResult(
  msg: SDKResultMessage,
): { input: number; output: number; cacheCreation: number; cacheRead: number } | null {
  const u = msg.usage as
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined;
  if (!u) return null;
  const input = numberOr0(u.input_tokens);
  const output = numberOr0(u.output_tokens);
  const cacheCreation = numberOr0(u.cache_creation_input_tokens);
  const cacheRead = numberOr0(u.cache_read_input_tokens);
  return { input, output, cacheCreation, cacheRead };
}

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function systemInitPayload(msg: SDKSystemMessage): Record<string, unknown> {
  return {
    thread_id: msg.session_id,
    model: msg.model,
    cwd: msg.cwd,
    tools: msg.tools,
    permission_mode: msg.permissionMode,
    mcp_servers: msg.mcp_servers,
    api_key_source: msg.apiKeySource,
  };
}

function summarizeAssistant(msg: SDKMessage): string | undefined {
  if (msg.type !== "assistant") return undefined;
  const blocks = msg.message?.content ?? [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (trimmed.length === 0) continue;
      return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
    }
  }
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}
