import type { ConfigSnapshot } from "../config/snapshot.js";
import type { Issue } from "../tracker/types.js";
import type { AgentEvent } from "./events.js";

export interface SessionInfo {
  thread_id: string;
  codex_app_server_pid: number | null;
}

export interface TurnResult {
  ok: boolean;
  turn_id: string | null;
  session_id: string | null;
  reason?:
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_input_required"
    | "turn_timeout"
    | "subprocess_exit"
    | "transport_error";
  message?: string;
  usage?: {
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface StartSessionOptions {
  workspace: string;
  issue: Issue;
  /**
   * Full config snapshot. Each backend reads only the slice it understands
   * (e.g., `snapshot.codex` for the stdio backend, `snapshot.claude` for the SDK
   * backend). Passing the whole snapshot avoids coupling the orchestrator to the
   * active backend kind, and keeps reload behavior intact.
   */
  snapshot: ConfigSnapshot;
  /** Receives session/transport-level events (e.g., session_started). */
  onEvent?: (e: AgentEvent) => void;
  /** Optional abort signal — wired through to the agent so cancellation propagates. */
  signal?: AbortSignal;
}

export interface RunTurnOptions {
  prompt: string;
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  /** Receives streaming events for the turn. */
  onEvent: (e: AgentEvent) => void;
}

export interface AgentSession {
  info: SessionInfo;
  runTurn(opts: RunTurnOptions): Promise<TurnResult>;
  stop(): Promise<void>;
}

export interface AgentClient {
  startSession(opts: StartSessionOptions): Promise<AgentSession>;
}
