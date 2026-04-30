import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type {
  AgentClient,
  AgentSession,
  RunTurnOptions,
  StartSessionOptions,
  TurnResult,
} from "./client.js";
import { extractAbsoluteTokenUsage, type AgentEvent } from "./events.js";
import {
  LINEAR_GRAPHQL_TOOL_NAME,
  runLinearGraphql,
  validateOperation,
  type LinearGraphqlResult,
} from "./linear-graphql-tool.js";

export interface StdioCodexClientOptions {
  /** Maximum allowed JSON line length. Default 10 MB per spec §10.1. */
  maxLineBytes?: number;
  /** Optional stderr handler (for diagnostic logging). */
  onStderr?: (chunk: string) => void;
  /** Optional shell. Default `bash`. */
  shell?: string;
  /** Override fetch for the linear_graphql tool (tests). */
  fetchImpl?: typeof fetch;
  /** Override child spawn for tests. Replaces `spawn(shell, ...)`. */
  spawnImpl?: typeof spawn;
}

/** JSON-Schema for the `linear_graphql` tool input (Codex side does not consume zod). */
const LINEAR_GRAPHQL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    variables: { type: "object" },
  },
  required: ["query"],
} as const;

const LINEAR_GRAPHQL_DESCRIPTION =
  "Execute a single GraphQL query or mutation against Linear using Symphony's configured tracker auth.";

/** Best-effort registration shapes (`SPEC.md:1051-1053`); first to succeed wins. */
const TOOL_REGISTER_METHODS = ["registerTools", "tool/register", "setTools"] as const;

interface PendingResolver<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

interface StdioSessionState {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  threadId: string | null;
  pid: number | null;
  pendingRequests: Map<string, PendingResolver<unknown>>;
  turnHandler:
    | null
    | ((evt: ProtocolMessage) => void);
  exited: boolean;
  exitError?: Error;
  toolsAdvertised: boolean;
  /** Tracker auth captured at `startSession` for `linear_graphql` execution. */
  trackerEndpoint: string | null;
  trackerApiKey: string | null;
  trackerKind: string | null;
  fetchImpl: typeof fetch;
}

interface ProtocolMessage {
  type?: string;
  event?: string;
  id?: string;
  request_id?: string;
  thread_id?: string;
  threadId?: string;
  turn_id?: string;
  turnId?: string;
  result?: unknown;
  error?: { message?: string; code?: string } | string;
  [key: string]: unknown;
}

export class StdioCodexClient implements AgentClient {
  constructor(private readonly opts: StdioCodexClientOptions = {}) {}

  async startSession(opts: StartSessionOptions): Promise<AgentSession> {
    const config = opts.snapshot.codex;
    const command = config.command;
    if (!command || !command.trim()) {
      throw new Error("codex.command is empty");
    }
    const shell = this.opts.shell ?? "bash";
    const spawnFn = this.opts.spawnImpl ?? spawn;

    const child = spawnFn(shell, ["-lc", command], {
      cwd: opts.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    const tracker = opts.snapshot.tracker;
    const state: StdioSessionState = {
      child,
      threadId: null,
      pid: child.pid ?? null,
      pendingRequests: new Map(),
      turnHandler: null,
      exited: false,
      toolsAdvertised: false,
      trackerEndpoint: tracker.endpoint || null,
      trackerApiKey: tracker.api_key || null,
      trackerKind: tracker.kind || null,
      fetchImpl: this.opts.fetchImpl ?? fetch,
    };

    this.attachStdoutFraming(state, opts);
    this.attachStderr(state);
    this.attachExit(state, opts);

    // Initialize / create thread per Codex protocol (best-effort, version-dependent).
    try {
      await this.initialize(state, opts);
    } catch (e) {
      try {
        child.kill();
      } catch {}
      throw e;
    }

    opts.onEvent?.({
      event: "session_started",
      timestamp: nowIso(),
      thread_id: state.threadId,
      codex_app_server_pid: state.pid,
      session_id: state.threadId ? `${state.threadId}-init` : null,
      raw: null,
    });

    return new StdioCodexSession(state, this.opts);
  }

  private attachStdoutFraming(state: StdioSessionState, opts: StartSessionOptions): void {
    const max = this.opts.maxLineBytes ?? 10 * 1024 * 1024;
    let buf = "";
    state.child.stdout.setEncoding("utf8");
    state.child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > max) {
        // Reset to avoid runaway memory; emit malformed.
        opts.onEvent?.({
          event: "malformed",
          timestamp: nowIso(),
          message: `stdout buffer exceeded ${max} bytes; resetting`,
          raw: null,
        });
        buf = "";
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed: ProtocolMessage;
        try {
          parsed = JSON.parse(line) as ProtocolMessage;
        } catch {
          opts.onEvent?.({
            event: "malformed",
            timestamp: nowIso(),
            message: line.length > 200 ? line.slice(0, 200) + "…" : line,
          });
          continue;
        }
        this.handleMessage(state, parsed, opts);
      }
    });
  }

  private attachStderr(state: StdioSessionState): void {
    state.child.stderr.setEncoding("utf8");
    state.child.stderr.on("data", (chunk: string) => {
      this.opts.onStderr?.(chunk);
    });
  }

  private attachExit(state: StdioSessionState, opts: StartSessionOptions): void {
    state.child.on("exit", (code, signal) => {
      state.exited = true;
      const err = new Error(
        `codex subprocess exited code=${code ?? "?"} signal=${signal ?? "?"}`,
      );
      state.exitError = err;
      // Reject any pending requests.
      for (const [, p] of state.pendingRequests) p.reject(err);
      state.pendingRequests.clear();
      // Notify turn handler so awaiting turns can settle.
      state.turnHandler?.({ type: "subprocess_exit" });
      opts.onEvent?.({
        event: "other_message",
        timestamp: nowIso(),
        message: err.message,
      });
    });
  }

  private handleMessage(
    state: StdioSessionState,
    msg: ProtocolMessage,
    opts: StartSessionOptions,
  ): void {
    // Resolve pending request/response if id matches.
    const reqId = (msg.request_id ?? msg.id) as string | undefined;
    if (reqId && state.pendingRequests.has(reqId)) {
      const pending = state.pendingRequests.get(reqId);
      state.pendingRequests.delete(reqId);
      if (msg.error) {
        const errMsg =
          typeof msg.error === "string" ? msg.error : msg.error.message ?? "unknown error";
        pending?.reject(new Error(errMsg));
      } else {
        pending?.resolve(msg.result ?? msg);
      }
      return;
    }

    // Inbound client-side tool call (SPEC.md:1041-1054). Recognise a few common
    // shapes and respond on stdin so the session does not stall.
    const toolCall = recogniseToolCall(msg);
    if (toolCall) {
      void this.respondToToolCall(state, toolCall, opts);
      return;
    }

    // Pull thread id from any message that supplies it.
    const threadIdFromMsg = (msg.thread_id ?? msg.threadId) as string | undefined;
    if (threadIdFromMsg && !state.threadId) {
      state.threadId = threadIdFromMsg;
    }

    // Token usage updates.
    const usage = extractAbsoluteTokenUsage(msg);
    if (usage) {
      opts.onEvent?.({
        event: "other_message",
        timestamp: nowIso(),
        thread_id: state.threadId,
        codex_app_server_pid: state.pid,
        usage,
      });
    }

    // Turn-handler dispatch (active turn consumes most signals).
    state.turnHandler?.(msg);
  }

  /**
   * Execute a recognised inbound tool call and write the structured result back
   * to the agent server's stdin. Unsupported tool names emit an
   * `unsupported_tool_call` event and still respond with a failure result so
   * the session does not stall (`SPEC.md:1041-1045, 2025`).
   */
  private async respondToToolCall(
    state: StdioSessionState,
    call: RecognisedToolCall,
    opts: StartSessionOptions,
  ): Promise<void> {
    let result: LinearGraphqlResult;
    if (call.toolName !== LINEAR_GRAPHQL_TOOL_NAME) {
      opts.onEvent?.({
        event: "unsupported_tool_call",
        timestamp: nowIso(),
        thread_id: state.threadId,
        codex_app_server_pid: state.pid,
        message: call.toolName,
      });
      result = {
        success: false,
        error: { code: "unsupported", message: `unsupported tool: ${call.toolName}` },
      };
    } else if (
      !state.trackerApiKey ||
      !state.trackerEndpoint ||
      state.trackerKind !== "linear"
    ) {
      result = {
        success: false,
        error: { code: "unsupported", message: "linear_graphql tool requires linear tracker auth" },
      };
    } else {
      const args = (call.arguments ?? {}) as { query?: unknown; variables?: unknown };
      const query = typeof args.query === "string" ? args.query : "";
      const validation = validateOperation(query);
      if (validation) {
        result = { success: false, error: { code: "invalid_input", message: validation } };
      } else {
        const variables =
          args.variables && typeof args.variables === "object" && !Array.isArray(args.variables)
            ? (args.variables as Record<string, unknown>)
            : undefined;
        result = await runLinearGraphql({
          endpoint: state.trackerEndpoint,
          apiKey: state.trackerApiKey,
          query,
          variables,
          fetchImpl: state.fetchImpl,
        });
      }
    }

    const responsePayload: Record<string, unknown> = {
      type: "tool_result",
      success: result.success,
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.success,
    };
    responsePayload[call.idField] = call.id;
    try {
      state.child.stdin.write(JSON.stringify(responsePayload) + "\n");
    } catch {
      // Subprocess gone — exit handler will reject pending work.
    }
  }

  private async initialize(
    state: StdioSessionState,
    opts: StartSessionOptions,
  ): Promise<void> {
    // The exact init/thread-create protocol is version-dependent. We try a couple of
    // common shapes; if neither succeeds within read_timeout_ms, we proceed without a
    // pre-known thread_id. Subsequent messages will populate state.threadId.
    const readTimeoutMs = opts.snapshot.codex.read_timeout_ms;

    // Try `initialize` request.
    try {
      await this.request(state, "initialize", { protocolVersion: "1" }, readTimeoutMs);
    } catch {
      // ignore
    }

    // Try create thread.
    try {
      const result = (await this.request(
        state,
        "createThread",
        { cwd: opts.workspace, title: `${opts.issue.identifier}: ${opts.issue.title}` },
        readTimeoutMs,
      )) as { thread_id?: string; threadId?: string } | undefined;
      const tid = result?.thread_id ?? result?.threadId;
      if (typeof tid === "string") state.threadId = tid;
    } catch {
      // ignore — thread id may arrive later via streamed events
    }

    // Best-effort advertise the `linear_graphql` client-side tool extension
    // (SPEC.md:1047-1087). The exact registration shape is targeted-protocol
    // version-dependent (SPEC.md:1051-1053); try a few common shapes and
    // continue without the tool if none is recognised.
    if (state.trackerKind === "linear" && state.trackerApiKey && state.trackerEndpoint) {
      const tools = [
        {
          name: LINEAR_GRAPHQL_TOOL_NAME,
          description: LINEAR_GRAPHQL_DESCRIPTION,
          inputSchema: LINEAR_GRAPHQL_INPUT_SCHEMA,
        },
      ];
      const shapes: Array<{ method: string; params: unknown }> = [
        { method: "registerTools", params: { tools } },
        { method: "tool/register", params: { ...tools[0] } },
        { method: "setTools", params: { tools } },
      ];
      for (const shape of shapes) {
        try {
          await this.request(state, shape.method, shape.params, readTimeoutMs);
          state.toolsAdvertised = true;
          break;
        } catch {
          // try the next shape
        }
      }
    }
  }

  private request<T>(
    state: StdioSessionState,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    if (state.exited) return Promise.reject(state.exitError ?? new Error("codex exited"));
    const id = randomUUID();
    const payload = JSON.stringify({ id, type: method, method, params }) + "\n";
    const promise = new Promise<T>((resolve, reject) => {
      state.pendingRequests.set(id, {
        resolve: (v: unknown) => resolve(v as T),
        reject,
      });
      const timer = setTimeout(() => {
        if (state.pendingRequests.delete(id)) {
          reject(new Error(`codex request "${method}" timed out after ${timeoutMs}ms`));
        }
      }, Math.max(1, timeoutMs));
      const onSettle = () => clearTimeout(timer);
      const orig = state.pendingRequests.get(id);
      if (orig) {
        const wrapped: PendingResolver<unknown> = {
          resolve: (v) => {
            onSettle();
            orig.resolve(v);
          },
          reject: (e) => {
            onSettle();
            orig.reject(e);
          },
        };
        state.pendingRequests.set(id, wrapped);
      }
    });
    state.child.stdin.write(payload, (err) => {
      if (err) {
        const p = state.pendingRequests.get(id);
        state.pendingRequests.delete(id);
        p?.reject(err);
      }
    });
    return promise;
  }
}

class StdioCodexSession implements AgentSession {
  constructor(
    private readonly state: StdioSessionState,
    private readonly opts: StdioCodexClientOptions,
  ) {}

  get info() {
    return {
      thread_id: this.state.threadId ?? "unknown",
      codex_app_server_pid: this.state.pid,
    };
  }

  async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
    if (this.state.exited) {
      return {
        ok: false,
        turn_id: null,
        session_id: null,
        reason: "subprocess_exit",
        message: this.state.exitError?.message ?? "codex exited before turn",
      };
    }

    const turnId = randomUUID();
    const turnTimeoutMs = 0; // The orchestrator caller wraps with the configured turn_timeout_ms.

    const payload = {
      id: turnId,
      type: "turn",
      method: "runTurn",
      params: {
        thread_id: this.state.threadId,
        prompt: opts.prompt,
        attempt: opts.attempt,
        turn_number: opts.turnNumber,
        issue: {
          id: opts.issue.id,
          identifier: opts.issue.identifier,
          title: opts.issue.title,
        },
      },
    };

    let resolveTurn: (r: TurnResult) => void = () => {};
    const turnPromise = new Promise<TurnResult>((resolve) => {
      resolveTurn = resolve;
    });

    const messageHandler = (msg: ProtocolMessage) => {
      const tid = (msg.turn_id ?? msg.turnId) as string | undefined;
      if (tid && tid !== turnId && (msg.type === "turn_completed" || msg.type === "turn_failed")) {
        return; // not our turn
      }
      const evt = mapEvent(msg);
      if (evt) {
        opts.onEvent({
          ...evt,
          timestamp: nowIso(),
          thread_id: this.state.threadId,
          codex_app_server_pid: this.state.pid,
          session_id: this.state.threadId ? `${this.state.threadId}-${tid ?? turnId}` : null,
        });
      }

      if (msg.type === "subprocess_exit") {
        resolveTurn({
          ok: false,
          turn_id: turnId,
          session_id: this.state.threadId ? `${this.state.threadId}-${turnId}` : null,
          reason: "subprocess_exit",
          message: this.state.exitError?.message ?? "codex exited",
        });
        return;
      }

      if (msg.type === "turn_completed") {
        resolveTurn({
          ok: true,
          turn_id: tid ?? turnId,
          session_id: this.state.threadId ? `${this.state.threadId}-${tid ?? turnId}` : null,
          reason: "turn_completed",
        });
      } else if (msg.type === "turn_failed" || msg.type === "turn_ended_with_error") {
        resolveTurn({
          ok: false,
          turn_id: tid ?? turnId,
          session_id: this.state.threadId ? `${this.state.threadId}-${tid ?? turnId}` : null,
          reason: "turn_failed",
          message: typeof msg.error === "string" ? msg.error : msg.error?.message ?? "turn failed",
        });
      } else if (msg.type === "turn_cancelled") {
        resolveTurn({
          ok: false,
          turn_id: tid ?? turnId,
          session_id: this.state.threadId ? `${this.state.threadId}-${tid ?? turnId}` : null,
          reason: "turn_cancelled",
        });
      } else if (msg.type === "turn_input_required") {
        // High-trust default: treat user-input-required as failure.
        resolveTurn({
          ok: false,
          turn_id: tid ?? turnId,
          session_id: this.state.threadId ? `${this.state.threadId}-${tid ?? turnId}` : null,
          reason: "turn_input_required",
          message: "user input required (treated as failure per high-trust policy)",
        });
      }
    };

    this.state.turnHandler = messageHandler;
    this.state.child.stdin.write(JSON.stringify(payload) + "\n");

    const result = await turnPromise;
    this.state.turnHandler = null;
    return result;
  }

  async stop(): Promise<void> {
    if (this.state.exited) return;
    try {
      this.state.child.stdin.end();
    } catch {}
    try {
      this.state.child.kill("SIGTERM");
    } catch {}
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.state.child.kill("SIGKILL");
        } catch {}
        resolve();
      }, 1500);
      this.state.child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
      if (this.state.exited) {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

function mapEvent(msg: ProtocolMessage): AgentEvent | null {
  const type = typeof msg.type === "string" ? msg.type : "";
  switch (type) {
    case "turn_completed":
      return { event: "turn_completed", timestamp: nowIso(), raw: msg };
    case "turn_failed":
      return { event: "turn_failed", timestamp: nowIso(), raw: msg };
    case "turn_cancelled":
      return { event: "turn_cancelled", timestamp: nowIso(), raw: msg };
    case "turn_input_required":
      return { event: "turn_input_required", timestamp: nowIso(), raw: msg };
    case "approval_auto_approved":
      return { event: "approval_auto_approved", timestamp: nowIso(), raw: msg };
    case "unsupported_tool_call":
      return { event: "unsupported_tool_call", timestamp: nowIso(), raw: msg };
    case "notification":
      return {
        event: "notification",
        timestamp: nowIso(),
        message:
          typeof msg.message === "string"
            ? msg.message
            : typeof (msg as { text?: string }).text === "string"
              ? (msg as { text?: string }).text
              : null,
        raw: msg,
      };
    case "rate_limits_updated":
      return { event: "rate_limits_updated", timestamp: nowIso(), rate_limits: msg, raw: msg };
    default:
      if (type) return { event: "other_message", timestamp: nowIso(), message: type, raw: msg };
      return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

interface RecognisedToolCall {
  /** Tool name as advertised. */
  toolName: string;
  /** The id field on the inbound call — replayed verbatim on the response. */
  idField: "request_id" | "id" | "call_id";
  id: string;
  arguments: unknown;
}

/**
 * Best-effort detection of an inbound client-side tool-call request.
 * Codex protocol shape is version-dependent (`SPEC.md:1051-1053`) — accept any
 * of the common shapes so a single integration point handles all of them.
 */
function recogniseToolCall(msg: ProtocolMessage): RecognisedToolCall | null {
  const type = typeof msg.type === "string" ? msg.type : "";

  // Shape A: { type: "tool_call", request_id, name, arguments }
  if (type === "tool_call") {
    const id = (msg.request_id ?? msg.id) as string | undefined;
    const name = (msg as { name?: unknown }).name;
    if (typeof id === "string" && typeof name === "string") {
      return {
        toolName: name,
        idField: msg.request_id ? "request_id" : "id",
        id,
        arguments: (msg as { arguments?: unknown }).arguments,
      };
    }
  }

  // Shape B: { type: "tool/use", id, tool_name, input }
  if (type === "tool/use") {
    const id = (msg.id ?? msg.request_id) as string | undefined;
    const name = (msg as { tool_name?: unknown }).tool_name;
    if (typeof id === "string" && typeof name === "string") {
      return {
        toolName: name,
        idField: msg.id ? "id" : "request_id",
        id,
        arguments: (msg as { input?: unknown }).input,
      };
    }
  }

  // Shape C: { type: "client_tool_request", call_id, tool, params }
  if (type === "client_tool_request") {
    const id = (msg as { call_id?: unknown }).call_id;
    const name = (msg as { tool?: unknown }).tool;
    if (typeof id === "string" && typeof name === "string") {
      return {
        toolName: name,
        idField: "call_id",
        id,
        arguments: (msg as { params?: unknown }).params,
      };
    }
  }

  return null;
}
