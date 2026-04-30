import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { StdioCodexClient } from "../../src/agent/stdio-client.js";
import { buildSnapshot, type ConfigSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { join } from "node:path";
import type { Issue } from "../../src/tracker/types.js";

type Line = string;

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  kill: (sig?: string) => boolean;
  written: Line[];
  pushStdout: (line: string) => void;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 4242;
  ee.written = [];
  ee.stdin = new Writable({
    write(chunk, _enc, cb) {
      ee.written.push(chunk.toString());
      cb();
    },
  });
  ee.stdout = new Readable({ read() {} });
  ee.stderr = new Readable({ read() {} });
  ee.kill = () => {
    queueMicrotask(() => ee.emit("exit", 0, null));
    return true;
  };
  ee.pushStdout = (line: string) => {
    ee.stdout.push(line.endsWith("\n") ? line : line + "\n");
  };
  return ee;
}

function buildSnap(): ConfigSnapshot {
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
agent:
  backend: codex
  max_concurrent_agents: 1
  max_turns: 1
codex:
  command: codex app-server
  turn_timeout_ms: 5000
  read_timeout_ms: 100`;
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody\n`);
  return buildSnapshot(join("/tmp", "WORKFLOW.md"), def, { K: "lin_xxx" } as NodeJS.ProcessEnv);
}

const issue: Issue = {
  id: "i1",
  identifier: "MT-1",
  title: "Test",
  description: null,
  priority: null,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

/**
 * Drives `startSession` to completion by replying to outbound JSON-RPC requests
 * on stdin with the configured policy:
 *   - registerStrategy: which of registerTools / tool/register / setTools succeeds
 *   - createThread always succeeds (returns a thread id)
 */
function makeSpawnImpl(
  child: FakeChild,
  registerStrategy: "registerTools" | "tool/register" | "setTools" | "all-fail" = "registerTools",
) {
  // Set up the stdin observer synchronously so the very first request from
  // initialize() is intercepted (queueMicrotask races the request's own write).
  observe(child, registerStrategy);
  const spawnImpl = vi.fn(() => {
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
  return spawnImpl;
}

function observe(child: FakeChild, strategy: "registerTools" | "tool/register" | "setTools" | "all-fail") {
  const dataHandler = (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      let parsed: { id?: string; method?: string; type?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const method = parsed.method ?? parsed.type;
      const reqId = parsed.id;
      if (!reqId) continue;
      if (method === "initialize") {
        child.pushStdout(JSON.stringify({ id: reqId, result: { ok: true } }));
        continue;
      }
      if (method === "createThread") {
        child.pushStdout(JSON.stringify({ id: reqId, result: { thread_id: "thr-1" } }));
        continue;
      }
      if (method === "registerTools" || method === "tool/register" || method === "setTools") {
        if (strategy === "all-fail") {
          child.pushStdout(JSON.stringify({ id: reqId, error: { message: "not supported" } }));
        } else if (method === strategy) {
          child.pushStdout(JSON.stringify({ id: reqId, result: { ok: true } }));
        } else {
          child.pushStdout(JSON.stringify({ id: reqId, error: { message: "not supported" } }));
        }
        continue;
      }
    }
  };
  // Hook the writable so we observe each write
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    const r = origWrite(chunk as never, ...(rest as never[]));
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      dataHandler(Buffer.from(chunk as string | Buffer));
    }
    return r;
  }) as typeof child.stdin.write;
}

describe("StdioCodexClient — linear_graphql tool advertising (SPEC.md:1051-1053, 2018)", () => {
  it("advertises the tool via registerTools when supported", async () => {
    const child = makeFakeChild();
    const client = new StdioCodexClient({ spawnImpl: makeSpawnImpl(child, "registerTools") as never });
    const session = await client.startSession({
      workspace: "/tmp/ws",
      issue,
      snapshot: buildSnap(),
      onEvent: () => {},
    });
    const writes = child.written.join("");
    expect(writes).toContain('"registerTools"');
    expect(writes).toContain('"linear_graphql"');
    await session.stop();
  });

  it("falls through silently when no shape is recognised", async () => {
    const child = makeFakeChild();
    const client = new StdioCodexClient({ spawnImpl: makeSpawnImpl(child, "all-fail") as never });
    const events: string[] = [];
    const session = await client.startSession({
      workspace: "/tmp/ws",
      issue,
      snapshot: buildSnap(),
      onEvent: (e) => events.push(e.event),
    });
    expect(events).toContain("session_started");
    await session.stop();
  });
});

describe("StdioCodexClient — inbound tool calls (SPEC.md:2022-2025)", () => {
  it("executes linear_graphql via runLinearGraphql and writes a tool_result line", async () => {
    const child = makeFakeChild();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new StdioCodexClient({
      spawnImpl: makeSpawnImpl(child, "registerTools") as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws",
      issue,
      snapshot: buildSnap(),
      onEvent: () => {},
    });

    // Simulate the agent server invoking the tool.
    child.pushStdout(
      JSON.stringify({
        type: "tool_call",
        request_id: "call-1",
        name: "linear_graphql",
        arguments: { query: "{ viewer { id } }" },
      }),
    );
    await waitFor(() =>
      child.written.some((w) => w.includes('"tool_result"') && w.includes('"success":true')),
    );
    expect(fetchImpl).toHaveBeenCalled();
    const resultLine = child.written.find((w) => w.includes('"tool_result"'))!;
    expect(resultLine).toContain('"request_id":"call-1"');
    await session.stop();
  });

  it("rejects multi-operation queries with invalid_input (SPEC.md:1077)", async () => {
    const child = makeFakeChild();
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const client = new StdioCodexClient({
      spawnImpl: makeSpawnImpl(child, "registerTools") as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws",
      issue,
      snapshot: buildSnap(),
      onEvent: () => {},
    });
    child.pushStdout(
      JSON.stringify({
        type: "tool/use",
        id: "use-1",
        tool_name: "linear_graphql",
        input: { query: "query A { viewer { id } } mutation B { issueUpdate { id } }" },
      }),
    );
    await waitFor(() => child.written.some((w) => w.includes("invalid_input")));
    expect(fetchImpl).not.toHaveBeenCalled();
    const line = child.written.find((w) => w.includes("invalid_input"))!;
    expect(line).toContain('"id":"use-1"');
    expect(line).toContain('"isError":true');
    await session.stop();
  });

  it("emits unsupported_tool_call for unknown tool names without stalling (SPEC.md:1041-1045, 2025)", async () => {
    const child = makeFakeChild();
    const events: string[] = [];
    const client = new StdioCodexClient({
      spawnImpl: makeSpawnImpl(child, "registerTools") as never,
    });
    const session = await client.startSession({
      workspace: "/tmp/ws",
      issue,
      snapshot: buildSnap(),
      onEvent: (e) => events.push(e.event),
    });
    child.pushStdout(
      JSON.stringify({
        type: "client_tool_request",
        call_id: "c-9",
        tool: "fictional_tool",
        params: {},
      }),
    );
    await waitFor(() => events.includes("unsupported_tool_call"));
    expect(events).toContain("unsupported_tool_call");
    const line = child.written.find((w) => w.includes("unsupported"))!;
    expect(line).toContain('"call_id":"c-9"');
    await session.stop();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
}
