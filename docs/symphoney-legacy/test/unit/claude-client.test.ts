import { describe, it, expect } from "vitest";
import type { ConfigSnapshot } from "../../src/config/snapshot.js";
import type { Issue } from "../../src/tracker/types.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { ClaudeAgentClient } from "../../src/agent/claude-client.js";

/**
 * The SDK exposes `query()` as `(args) => Query` where Query is an async iterable
 * of SDKMessage. We construct a fake query that yields a scripted sequence of
 * messages — enough to exercise the adapter's translation logic end-to-end.
 */
type Scenario = "success" | "no_result" | "error_response" | "success_with_cache";

function makeFakeQuery(scenario: Scenario, sessionId = "session-abc-123") {
  return function fakeQuery(_args: { prompt: string; options: unknown }): AsyncIterable<unknown> & { _ack: true } {
    const messages: unknown[] = [];
    messages.push({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "claude-sonnet-4-6",
      cwd: "/tmp/work",
      tools: ["Read", "Edit"],
      permissionMode: "bypassPermissions",
      mcp_servers: [],
      apiKeySource: "user",
    });
    messages.push({
      type: "assistant",
      uuid: "asst-1",
      message: { content: [{ type: "text", text: "I will fix this." }] },
    });
    if (scenario === "no_result") {
      // omit any "result" message
    } else if (scenario === "error_response") {
      messages.push({
        type: "result",
        uuid: "result-uuid-2",
        subtype: "error_max_turns",
        num_turns: 3,
        usage: { input_tokens: 100, output_tokens: 40 },
      });
    } else if (scenario === "success_with_cache") {
      messages.push({
        type: "result",
        uuid: "result-uuid-1",
        subtype: "success",
        num_turns: 2,
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 500,
        },
      });
    } else {
      messages.push({
        type: "result",
        uuid: "result-uuid-1",
        subtype: "success",
        num_turns: 2,
        usage: { input_tokens: 200, output_tokens: 80 },
      });
    }

    // Type-cast as the SDK's Query for adapter compatibility.
    const iter = {
      _ack: true as const,
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (i < messages.length) {
              return Promise.resolve({ value: messages[i++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    return iter;
  };
}

function makeSnapshot(claudeOverrides: Partial<ConfigSnapshot["claude"]> = {}): ConfigSnapshot {
  return {
    workflow_path: "/tmp/W.md",
    workflow_dir: "/tmp",
    prompt_template: "p",
    raw: {},
    tracker: {
      kind: "linear",
      endpoint: "",
      api_key: "k",
      project_slug: "p",
      active_states: [],
      terminal_states: [],
      repository: null,
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: "/tmp/ws" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 5_000,
    },
    agent: {
      backend: "claude",
      max_concurrent_agents: 1,
      max_turns: 1,
      max_retry_backoff_ms: 0,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 60_000,
      stall_timeout_ms: 0,
      continuation_prompt: "continue",
    },
    codex: {
      command: "",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 60_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 0,
    },
    claude: {
      model: "claude-sonnet-4-6",
      allowed_tools: ["Read"],
      permission_mode: "bypassPermissions",
      force_subscription_auth: false,
      turn_timeout_ms: 60_000,
      read_timeout_ms: 30_000,
      stall_timeout_ms: 0,
      ...claudeOverrides,
    },
    server: { port: null, bind_host: "127.0.0.1" },
  };
}

const issue: Issue = {
  id: "i1",
  identifier: "MT-1",
  title: "do thing",
  description: "",
  priority: 0,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: new Date("2026-01-01"),
  updated_at: new Date("2026-01-01"),
};

describe("ClaudeAgentClient", () => {
  it("on success: emits session_started, captures thread_id, returns turn_completed with usage", async () => {
    const sessionEvents: AgentEvent[] = [];
    const turnEvents: AgentEvent[] = [];

    const client = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("success") as never,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws/MT-1",
      issue,
      snapshot: makeSnapshot(),
      onEvent: (e) => sessionEvents.push(e),
    });

    const result = await session.runTurn({
      prompt: "do the thing",
      issue,
      attempt: null,
      turnNumber: 1,
      onEvent: (e) => turnEvents.push(e),
    });

    expect(session.info.thread_id).toBe("session-abc-123");
    expect(session.info.codex_app_server_pid).toBeNull();
    expect(result).toEqual({
      ok: true,
      turn_id: "result-uuid-1",
      session_id: "session-abc-123-result-uuid-1",
      reason: "turn_completed",
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        total_tokens: 280,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    // session_started should arrive on the session-level handler.
    const started = sessionEvents.find((e) => e.event === "session_started");
    expect(started).toBeDefined();
    expect(started?.thread_id).toBe("session-abc-123");

    // Lifecycle events should hit the turn-level handler.
    const types = turnEvents.map((e) => e.event);
    expect(types).toContain("turn_started");
    expect(types).toContain("turn_completed");
    expect(types).toContain("notification");

    await session.stop();
  });

  it("on missing result message: returns turn_failed with no_result_message", async () => {
    const client = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("no_result") as never,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws/MT-1",
      issue,
      snapshot: makeSnapshot(),
    });
    const result = await session.runTurn({
      prompt: "do the thing",
      issue,
      attempt: null,
      turnNumber: 1,
      onEvent: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("turn_failed");
    expect(result.message).toBe("no result message");
    await session.stop();
  });

  it("on non-success result subtype: returns turn_failed with subtype as message", async () => {
    const client = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("error_response") as never,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws/MT-1",
      issue,
      snapshot: makeSnapshot(),
    });
    const result = await session.runTurn({
      prompt: "do the thing",
      issue,
      attempt: null,
      turnNumber: 1,
      onEvent: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("turn_failed");
    expect(result.message).toBe("error_max_turns");
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    await session.stop();
  });

  it("captures cache_creation_input_tokens and cache_read_input_tokens (SPEC.md:1304-1318)", async () => {
    const client = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("success_with_cache") as never,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws/MT-1",
      issue,
      snapshot: makeSnapshot(),
    });
    const result = await session.runTurn({
      prompt: "do the thing",
      issue,
      attempt: null,
      turnNumber: 1,
      onEvent: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      total_tokens: 280,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 500,
    });
    await session.stop();
  });

  it("second runTurn resumes the existing thread (continuation)", async () => {
    // Track what `options.resume` is set to on each call.
    const resumes: (string | undefined)[] = [];
    const queryFn = (args: { prompt: string; options: { resume?: string } }) => {
      resumes.push(args.options.resume);
      // First call: full success with init+result. Second call: just result.
      const isFirst = resumes.length === 1;
      const messages: unknown[] = [];
      if (isFirst) {
        messages.push({
          type: "system",
          subtype: "init",
          session_id: "thread-XYZ",
          model: "m",
          cwd: "/tmp",
          tools: [],
          permissionMode: "bypassPermissions",
          mcp_servers: [],
          apiKeySource: "user",
        });
      }
      messages.push({
        type: "result",
        uuid: isFirst ? "result-1" : "result-2",
        subtype: "success",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              return Promise.resolve(
                i < messages.length
                  ? { value: messages[i++], done: false }
                  : { value: undefined, done: true },
              );
            },
          };
        },
      };
    };

    const client = new ClaudeAgentClient({ queryImpl: queryFn as never });
    const session = await client.startSession({
      workspace: "/tmp/ws/MT-1",
      issue,
      snapshot: makeSnapshot(),
    });

    await session.runTurn({
      prompt: "first",
      issue,
      attempt: null,
      turnNumber: 1,
      onEvent: () => {},
    });
    await session.runTurn({
      prompt: "second",
      issue,
      attempt: null,
      turnNumber: 2,
      onEvent: () => {},
    });

    expect(resumes).toEqual([undefined, "thread-XYZ"]);
    await session.stop();
  });
});
