/**
 * Smoke test for the linear_graphql MCP tool wiring (PR 1, SPEC.md:1047-1087).
 *
 * Drives a real Claude Agent SDK turn and asks the agent to call linear_graphql.
 * The Linear endpoint is mocked via fetchImpl so this never hits real Linear —
 * we only need to confirm the tool is registered, exposed to the agent, and
 * that the MCP-registered handler calls our fetchImpl with a GraphQL POST.
 *
 * Run:
 *   pnpm exec tsx --env-file-if-exists=.env scripts/smoke-linear-graphql.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentClient } from "../src/agent/claude-client.js";
import type { ConfigSnapshot, ClaudeConfig, TrackerConfig } from "../src/config/snapshot.js";
import type { Issue } from "../src/tracker/types.js";
import type { AgentEvent } from "../src/agent/events.js";

const FORCE_SUBSCRIPTION_AUTH = true;
const MODEL = "claude-sonnet-4-6";

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "symphoney-linear-graphql-smoke-"));
  console.log(`[smoke] workspace: ${workspace}`);
  let exitCode = 0;
  const failures: string[] = [];

  // Capture every fetch the linear_graphql tool makes.
  interface CapturedCall {
    url: string;
    method: string;
    authHeader: string | undefined;
    body: { query?: string; variables?: unknown } | null;
  }
  const captured: CapturedCall[] = [];

  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: { query?: string; variables?: unknown } | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    captured.push({
      url,
      method,
      authHeader: headers["Authorization"] ?? headers["authorization"],
      body,
    });
    // Return a fake successful Linear viewer response.
    return new Response(
      JSON.stringify({ data: { viewer: { id: "viewer-fake", name: "Smoke Tester" } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  try {
    // Pre-warm to mirror factory.ts.
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const startupFn = (sdk as unknown as { startup?: () => Promise<unknown> }).startup;
      if (typeof startupFn === "function") {
        await startupFn();
        console.log("[smoke] startup() pre-warm ok");
      }
    } catch (e) {
      console.warn(`[smoke] pre-warm failed (continuing): ${(e as Error).message}`);
    }

    const claude: ClaudeConfig = {
      model: MODEL,
      // Note: we deliberately do NOT include the linear_graphql FQN here. The
      // claude-client should auto-add it when tracker is linear (PR 1 contract).
      allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "bypassPermissions",
      force_subscription_auth: FORCE_SUBSCRIPTION_AUTH,
      turn_timeout_ms: 120_000,
      read_timeout_ms: 30_000,
      stall_timeout_ms: 0,
    };

    const tracker: TrackerConfig = {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "lin_smoke_token",
      project_slug: "smoke",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    };

    const snapshot = { claude, tracker } as unknown as ConfigSnapshot;

    const issue: Issue = {
      id: "SMOKE-LG-1",
      identifier: "SMOKE-LG-1",
      title: "linear_graphql wiring smoke",
      description: null,
      priority: null,
      state: "InProgress",
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    };

    const events: AgentEvent[] = [];
    const onEvent = (e: AgentEvent) => {
      events.push(e);
      const usage = "usage" in e && e.usage ? ` usage=${JSON.stringify(e.usage)}` : "";
      const tid = "turn_id" in e && e.turn_id ? ` turn=${e.turn_id}` : "";
      const msg = "message" in e && e.message ? ` msg=${String(e.message).slice(0, 100)}` : "";
      console.log(`[event] ${e.event}${tid}${usage}${msg}`);
    };

    const client = new ClaudeAgentClient({ fetchImpl });
    console.log("[smoke] startSession()…");
    const session = await client.startSession({ workspace, issue, snapshot, onEvent });

    try {
      const prompt = [
        "You have access to a tool named `mcp__symphony__linear_graphql` (also referred to as `linear_graphql`).",
        "Your only task is to call that tool exactly once with this input:",
        "  { \"query\": \"{ viewer { id name } }\" }",
        "After the tool returns, summarise the result in one short sentence and stop.",
      ].join(" ");
      console.log("[smoke] runTurn()…");
      const result = await session.runTurn({
        prompt,
        issue,
        attempt: null,
        turnNumber: 1,
        onEvent,
      });

      console.log(`[smoke] result: ${JSON.stringify(result)}`);
      console.log(`[smoke] captured fetch calls: ${captured.length}`);
      for (const c of captured) {
        console.log(
          `  - ${c.method} ${c.url} auth=${c.authHeader ? "present" : "MISSING"} body.query=${(c.body?.query ?? "").slice(0, 60)}`,
        );
      }

      // Assertions
      if (!result.ok) failures.push(`result.ok = false (reason=${result.reason}, message=${result.message})`);
      if (captured.length === 0) {
        failures.push("linear_graphql tool was never invoked — no fetch was captured");
      } else {
        const first = captured[0]!;
        if (first.method !== "POST") failures.push(`expected POST to Linear, got ${first.method}`);
        if (!first.url.includes("linear.app/graphql")) failures.push(`unexpected URL: ${first.url}`);
        if (first.authHeader !== "lin_smoke_token") failures.push(`Authorization header missing or wrong: ${first.authHeader}`);
        if (!first.body?.query?.includes("viewer")) failures.push(`body.query did not contain "viewer": ${JSON.stringify(first.body)}`);
      }
    } finally {
      console.log("[smoke] session.stop()…");
      await session.stop();
    }
  } catch (err) {
    failures.push(`uncaught: ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    try {
      rmSync(workspace, { recursive: true, force: true });
      console.log(`[smoke] cleaned up ${workspace}`);
    } catch (e) {
      console.warn(`[smoke] cleanup failed: ${(e as Error).message}`);
    }
  }

  if (failures.length > 0) {
    console.error("\n[smoke] FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    exitCode = 1;
  } else {
    console.log("\n[smoke] PASS");
  }
  process.exit(exitCode);
}

void main();
