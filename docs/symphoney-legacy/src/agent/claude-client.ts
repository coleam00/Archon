import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude-adapter.js";
import type {
  AgentClient,
  AgentSession,
  RunTurnOptions,
  StartSessionOptions,
  TurnResult,
} from "./client.js";
import type { AgentEvent } from "./events.js";
import type { ClaudeConfig } from "../config/snapshot.js";
import type { Issue } from "../tracker/types.js";
import {
  buildLinearGraphqlServer,
  LINEAR_GRAPHQL_FQN,
  LINEAR_GRAPHQL_MCP_NAME,
} from "./linear-graphql-tool.js";

export interface ClaudeAgentClientOptions {
  /** Override the SDK `query()` for tests. Forwarded to the internal adapter. */
  queryImpl?: ClaudeAdapterOptions["queryImpl"];
  /** Override fetch for the linear_graphql tool (tests). */
  fetchImpl?: typeof fetch;
}

export class ClaudeAgentClient implements AgentClient {
  constructor(private readonly opts: ClaudeAgentClientOptions = {}) {}

  async startSession(opts: StartSessionOptions): Promise<AgentSession> {
    const claude = opts.snapshot.claude;

    // Optional linear_graphql client-side tool (SPEC.md:1047-1087). Only
    // wired when tracker.kind=="linear" and auth is configured.
    const tracker = opts.snapshot.tracker;
    const linearServer =
      tracker && tracker.kind === "linear" && tracker.api_key && tracker.endpoint
        ? buildLinearGraphqlServer({
            endpoint: tracker.endpoint,
            apiKey: tracker.api_key,
            fetchImpl: this.opts.fetchImpl,
          })
        : null;
    const mcpServers: Record<string, McpServerConfig> | undefined = linearServer
      ? { [LINEAR_GRAPHQL_MCP_NAME]: linearServer }
      : undefined;
    const allowedTools = linearServer
      ? dedupe([...claude.allowed_tools, LINEAR_GRAPHQL_FQN])
      : [...claude.allowed_tools];

    const adapter = new ClaudeAdapter({
      cwd: opts.workspace,
      model: claude.model ?? undefined,
      turnTimeoutMs: claude.turn_timeout_ms,
      readTimeoutMs: claude.read_timeout_ms,
      allowedTools,
      mcpServers,
      permissionMode: claude.permission_mode,
      systemPrompt: buildSystemPrompt(opts.workspace),
      forceSubscriptionAuth: claude.force_subscription_auth,
      queryImpl: this.opts.queryImpl,
    });

    const abort = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) abort.abort();
      else opts.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    return new ClaudeAgentSession({
      adapter,
      abort,
      issue: opts.issue,
      onSessionEvent: opts.onEvent,
    });
  }
}

interface ClaudeSessionDeps {
  adapter: ClaudeAdapter;
  abort: AbortController;
  issue: Issue;
  onSessionEvent?: (e: AgentEvent) => void;
}

class ClaudeAgentSession implements AgentSession {
  private threadId: string | null = null;
  private firstTurnDone = false;
  private stopped = false;

  constructor(private readonly deps: ClaudeSessionDeps) {}

  get info() {
    return {
      thread_id: this.threadId ?? "unknown",
      codex_app_server_pid: null,
    };
  }

  async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
    if (this.stopped) {
      return {
        ok: false,
        turn_id: null,
        session_id: null,
        reason: "subprocess_exit",
        message: "session stopped",
      };
    }

    // Bridge: SDK adapter emits one stream of events; first turn's session_started
    // also goes to the session-level onEvent so the orchestrator captures it once.
    const seenSessionStart = this.firstTurnDone;
    const emit = (event: AgentEvent) => {
      if (event.event === "session_started" && !seenSessionStart) {
        this.deps.onSessionEvent?.(event);
        if (event.thread_id) this.threadId = event.thread_id;
      } else {
        opts.onEvent(event);
      }
    };

    const outcome = this.firstTurnDone
      ? await this.deps.adapter.runContinuationTurn({
          prompt: opts.prompt,
          emit,
          abort: this.deps.abort,
        })
      : await this.deps.adapter.runFirstTurn({
          prompt: opts.prompt,
          emit,
          abort: this.deps.abort,
        });

    if (outcome.threadId) this.threadId = outcome.threadId;
    this.firstTurnDone = true;

    const turnId = outcome.turnId ?? randomUUID();
    const sessionId = this.threadId ? `${this.threadId}-${turnId}` : null;
    const usage = outcome.usage
      ? {
          input_tokens: outcome.usage.input_tokens,
          output_tokens: outcome.usage.output_tokens,
          total_tokens: outcome.usage.total_tokens,
          cache_creation_input_tokens: outcome.usage.cache_creation_input_tokens,
          cache_read_input_tokens: outcome.usage.cache_read_input_tokens,
        }
      : undefined;

    switch (outcome.status) {
      case "completed":
        return {
          ok: true,
          turn_id: turnId,
          session_id: sessionId,
          reason: "turn_completed",
          usage,
        };
      case "timeout":
        return {
          ok: false,
          turn_id: turnId,
          session_id: sessionId,
          reason: "turn_timeout",
          message: outcome.error ?? "turn_timeout",
          usage,
        };
      case "cancelled":
        return {
          ok: false,
          turn_id: turnId,
          session_id: sessionId,
          reason: "turn_cancelled",
          message: outcome.error ?? "turn_cancelled",
          usage,
        };
      case "failed":
      default:
        return {
          ok: false,
          turn_id: turnId,
          session_id: sessionId,
          reason: "turn_failed",
          message: outcome.error ?? "turn_failed",
          usage,
        };
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.deps.abort.abort();
    } catch {
      // ignore
    }
    await this.deps.adapter.stop();
  }
}

function buildSystemPrompt(workspacePath: string): string {
  return `You are a coding agent operating inside an isolated workspace. Your working directory is ${workspacePath}. Stay inside this directory.`;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
