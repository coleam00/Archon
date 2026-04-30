import type {
  AgentClient,
  AgentSession,
  RunTurnOptions,
  StartSessionOptions,
  TurnResult,
} from "./client.js";
import type { AgentEvent } from "./events.js";

export type FakeTurnScript =
  | { kind: "complete"; tokens?: { input: number; output: number; total: number }; emitEvents?: AgentEvent[] }
  | { kind: "fail"; message?: string; emitEvents?: AgentEvent[] }
  | { kind: "cancel"; emitEvents?: AgentEvent[] }
  | { kind: "input_required"; emitEvents?: AgentEvent[] }
  | { kind: "stall"; durationMs: number; emitEvents?: AgentEvent[] }
  | { kind: "subprocess_exit"; emitEvents?: AgentEvent[] };

export interface FakeAgentController {
  scriptForIssue(issueId: string, turns: FakeTurnScript[]): void;
  defaultScript(turns: FakeTurnScript[]): void;
  failStartup(forIssueId: string, error: Error): void;
  /** Number of times runTurn was called for this issue across the test. */
  turnCalls: Map<string, number>;
  startedSessions: Map<string, number>;
  stoppedSessions: number;
  /** Prompts (in turn order) sent to runTurn per issue. */
  promptsForIssue: Map<string, string[]>;
}

export interface FakeAgentClientOptions {
  controller?: FakeAgentController;
}

export function makeFakeAgentClient(): { client: AgentClient; controller: FakeAgentController } {
  const issueScripts = new Map<string, FakeTurnScript[]>();
  let defaultScript: FakeTurnScript[] = [{ kind: "complete" }];
  const startupFailures = new Map<string, Error>();
  const controller: FakeAgentController = {
    scriptForIssue(issueId, turns) {
      issueScripts.set(issueId, [...turns]);
    },
    defaultScript(turns) {
      defaultScript = [...turns];
    },
    failStartup(issueId, error) {
      startupFailures.set(issueId, error);
    },
    turnCalls: new Map(),
    startedSessions: new Map(),
    stoppedSessions: 0,
    promptsForIssue: new Map(),
  };

  const client: AgentClient = {
    async startSession(opts: StartSessionOptions): Promise<AgentSession> {
      const issueId = opts.issue.id;
      const failure = startupFailures.get(issueId);
      if (failure) throw failure;
      const startedCount = (controller.startedSessions.get(issueId) ?? 0) + 1;
      controller.startedSessions.set(issueId, startedCount);
      const threadId = `thread-${issueId}-${startedCount}`;
      const queue = [...(issueScripts.get(issueId) ?? defaultScript)];
      let stopped = false;

      opts.onEvent?.({
        event: "session_started",
        timestamp: new Date().toISOString(),
        thread_id: threadId,
        session_id: `${threadId}-init`,
        codex_app_server_pid: 1234,
      });

      return {
        info: { thread_id: threadId, codex_app_server_pid: 1234 },
        async runTurn(turnOpts: RunTurnOptions): Promise<TurnResult> {
          if (stopped) {
            return {
              ok: false,
              turn_id: null,
              session_id: null,
              reason: "subprocess_exit",
              message: "session stopped",
            };
          }
          controller.turnCalls.set(issueId, (controller.turnCalls.get(issueId) ?? 0) + 1);
          const prompts = controller.promptsForIssue.get(issueId) ?? [];
          prompts.push(turnOpts.prompt);
          controller.promptsForIssue.set(issueId, prompts);
          const step = queue.shift() ?? defaultScript[defaultScript.length - 1];
          const turnId = `turn-${turnOpts.turnNumber}`;
          const sessionId = `${threadId}-${turnId}`;

          if (step?.emitEvents) {
            for (const e of step.emitEvents) turnOpts.onEvent(e);
          }

          switch (step?.kind) {
            case "complete":
              turnOpts.onEvent({
                event: "turn_completed",
                timestamp: new Date().toISOString(),
                thread_id: threadId,
                turn_id: turnId,
                session_id: sessionId,
                usage: step.tokens
                  ? {
                      input_tokens: step.tokens.input,
                      output_tokens: step.tokens.output,
                      total_tokens: step.tokens.total,
                    }
                  : null,
              });
              return { ok: true, turn_id: turnId, session_id: sessionId, reason: "turn_completed" };
            case "fail":
              return {
                ok: false,
                turn_id: turnId,
                session_id: sessionId,
                reason: "turn_failed",
                message: step.message ?? "fake failure",
              };
            case "cancel":
              return { ok: false, turn_id: turnId, session_id: sessionId, reason: "turn_cancelled" };
            case "input_required":
              return {
                ok: false,
                turn_id: turnId,
                session_id: sessionId,
                reason: "turn_input_required",
              };
            case "stall":
              await new Promise((r) => setTimeout(r, step.durationMs));
              return { ok: true, turn_id: turnId, session_id: sessionId, reason: "turn_completed" };
            case "subprocess_exit":
              return {
                ok: false,
                turn_id: turnId,
                session_id: sessionId,
                reason: "subprocess_exit",
              };
            default:
              return { ok: true, turn_id: turnId, session_id: sessionId, reason: "turn_completed" };
          }
        },
        async stop() {
          stopped = true;
          controller.stoppedSessions += 1;
        },
      };
    },
  };

  return { client, controller };
}
