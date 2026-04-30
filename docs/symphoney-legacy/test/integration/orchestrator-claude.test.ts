import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { buildSnapshot, type ConfigSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { ClaudeAgentClient } from "../../src/agent/claude-client.js";
import { makeFakeTracker, makeIssue } from "../helpers/fake-tracker.js";

function buildClaudeSnap(root: string): ConfigSnapshot {
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
polling:
  interval_ms: 1000000
agent:
  backend: claude
  max_concurrent_agents: 2
  max_turns: 1
codex:
  command: codex app-server
  turn_timeout_ms: 5000
claude:
  model: claude-sonnet-4-6
  allowed_tools: [Read, Edit]
  permission_mode: bypassPermissions
  turn_timeout_ms: 5000
  read_timeout_ms: 1000
  stall_timeout_ms: 0
workspace:
  root: ${root}`;
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody for {{ issue.identifier }}\n`);
  return buildSnapshot(join(root, "WORKFLOW.md"), def, { K: "tok" } as NodeJS.ProcessEnv);
}

function makeFakeQuery(
  threadId: string,
  capture?: { options: unknown },
  usage: Record<string, number> = { input_tokens: 50, output_tokens: 25 },
) {
  return function fakeQuery(args: { options?: unknown }) {
    if (capture) capture.options = args.options ?? null;
    const messages: unknown[] = [
      {
        type: "system",
        subtype: "init",
        session_id: threadId,
        model: "claude-sonnet-4-6",
        cwd: "/tmp",
        tools: ["Read"],
        permissionMode: "bypassPermissions",
        mcp_servers: [],
        apiKeySource: "user",
      },
      {
        type: "result",
        uuid: `${threadId}-turn-1`,
        subtype: "success",
        num_turns: 1,
        usage,
      },
    ];
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
}

const silentLogger = pino({ level: "silent" });

describe("orchestrator + Claude backend integration", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sym-claude-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("dispatches an issue, runs the SDK turn, and accumulates token totals", async () => {
    const snapshot = buildClaudeSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const agent = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("thread-i1") as never,
    });

    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent,
      workspaces,
      logger: silentLogger,
    });

    await orch.runTick();
    const entry = orch.internalState.running.get("i1");
    expect(entry).toBeDefined();

    // Once the worker finishes turn 1, max_turns=1 means it exits cleanly.
    if (entry?.worker_promise) await entry.worker_promise;

    expect(orch.internalState.running.has("i1")).toBe(false);
    expect(orch.internalState.completed.has("i1")).toBe(true);

    const snap = orch.getSnapshot();
    expect(snap.codex_totals.input_tokens).toBe(50);
    expect(snap.codex_totals.output_tokens).toBe(25);
    expect(snap.codex_totals.total_tokens).toBe(75);

    // controls keeps issue accessible for subsequent retries; we don't drive that here.
    expect(controls).toBeDefined();
    await orch.stop();
  });

  it("aggregates cache token usage from the SDK result (SPEC.md:1304-1318)", async () => {
    const snapshot = buildClaudeSnap(root);
    const issue = makeIssue({ id: "i3", identifier: "MT-3", state: "Todo" });
    const { tracker } = makeFakeTracker([issue]);
    const agent = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("thread-i3", undefined, {
        input_tokens: 50,
        output_tokens: 25,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      }) as never,
    });

    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent,
      workspaces,
      logger: silentLogger,
    });

    await orch.runTick();
    const entry = orch.internalState.running.get("i3");
    if (entry?.worker_promise) await entry.worker_promise;

    const snap = orch.getSnapshot();
    expect(snap.codex_totals.cache_creation_input_tokens).toBe(100);
    expect(snap.codex_totals.cache_read_input_tokens).toBe(200);
    await orch.stop();
  });

  it("registers the linear_graphql MCP server when tracker is linear with auth (SPEC.md:1047-1087)", async () => {
    const snapshot = buildClaudeSnap(root);
    const issue = makeIssue({ id: "i2", identifier: "MT-2", state: "Todo" });
    const { tracker } = makeFakeTracker([issue]);
    const captured: { options: unknown } = { options: null };
    const agent = new ClaudeAgentClient({
      queryImpl: makeFakeQuery("thread-i2", captured) as never,
    });

    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent,
      workspaces,
      logger: silentLogger,
    });

    await orch.runTick();
    const entry = orch.internalState.running.get("i2");
    if (entry?.worker_promise) await entry.worker_promise;

    const opts = captured.options as { mcpServers?: Record<string, unknown>; allowedTools?: string[] } | null;
    expect(opts).not.toBeNull();
    expect(opts!.mcpServers).toBeDefined();
    expect(opts!.mcpServers).toHaveProperty("symphony");
    expect(opts!.allowedTools).toContain("mcp__symphony__linear_graphql");

    await orch.stop();
  });
});
