/**
 * Real-SDK smoke test for the Claude Agent SDK backend.
 *
 * Constructs ClaudeAgentClient directly (no orchestrator, no Linear), runs one
 * turn against a temp workspace, asserts thread_id / usage / file creation,
 * then cleans up.
 *
 * Run:
 *   pnpm exec tsx --env-file-if-exists=.env scripts/smoke-claude.ts
 *
 * Auth: subscription/OAuth (force_subscription_auth = true). Requires `claude login`.
 * To switch to API-key auth, flip FORCE_SUBSCRIPTION_AUTH below and ensure
 * ANTHROPIC_API_KEY is set.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentClient } from "../src/agent/claude-client.js";
import type { ConfigSnapshot, ClaudeConfig } from "../src/config/snapshot.js";
import type { Issue } from "../src/tracker/types.js";
import type { AgentEvent } from "../src/agent/events.js";

const FORCE_SUBSCRIPTION_AUTH = true;
const MODEL = "claude-sonnet-4-6";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "symphoney-claude-smoke-"));
  console.log(`[smoke] workspace: ${workspace}`);
  console.log(`[smoke] auth: ${FORCE_SUBSCRIPTION_AUTH ? "subscription/OAuth" : "API key"}`);

  let exitCode = 0;
  const failures: string[] = [];

  try {
    // Mirror factory.ts pre-warm so the same SDK code path is exercised.
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const startupFn = (sdk as unknown as { startup?: () => Promise<unknown> }).startup;
      if (typeof startupFn === "function") {
        await startupFn();
        console.log("[smoke] startup() pre-warm ok");
      } else {
        console.log("[smoke] startup() not present on SDK export — skipping pre-warm");
      }
    } catch (e) {
      console.warn(`[smoke] pre-warm failed (continuing): ${(e as Error).message}`);
    }

    const claude: ClaudeConfig = {
      model: MODEL,
      allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "bypassPermissions",
      force_subscription_auth: FORCE_SUBSCRIPTION_AUTH,
      turn_timeout_ms: 120_000,
      read_timeout_ms: 30_000,
      stall_timeout_ms: 0,
    };

    // Only `snapshot.claude` is read by ClaudeAgentClient; the rest is filler.
    const snapshot = { claude } as unknown as ConfigSnapshot;

    const issue: Issue = {
      id: "SMOKE-1",
      identifier: "SMOKE-1",
      title: "Claude SDK smoke test",
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
      const msg = "message" in e && e.message ? ` msg=${String(e.message).slice(0, 80)}` : "";
      console.log(`[event] ${e.event}${tid}${usage}${msg}`);
    };

    const client = new ClaudeAgentClient();
    console.log("[smoke] startSession()…");
    const session = await client.startSession({
      workspace,
      issue,
      snapshot,
      onEvent,
    });

    try {
      const prompt =
        "Create a file named hello.txt in your current working directory containing the text \"hi\". After the file exists, stop.";
      console.log("[smoke] runTurn()…");
      const result = await session.runTurn({
        prompt,
        issue,
        attempt: null,
        turnNumber: 1,
        onEvent,
      });

      console.log(`[smoke] result: ${JSON.stringify(result)}`);
      console.log(`[smoke] session.info: ${JSON.stringify(session.info)}`);

      // Assertions
      const tid = session.info.thread_id;
      if (!tid || tid === "unknown" || !UUID_RE.test(tid)) {
        failures.push(`thread_id is not a UUID: ${tid}`);
      }

      if (!result.ok) failures.push(`result.ok = false (reason=${result.reason}, message=${result.message})`);
      if (result.reason !== "turn_completed") failures.push(`result.reason = ${result.reason}, expected turn_completed`);

      const u = result.usage;
      if (!u) failures.push("result.usage missing");
      else {
        if (!(typeof u.input_tokens === "number" && u.input_tokens > 0)) failures.push(`usage.input_tokens not > 0: ${u.input_tokens}`);
        if (!(typeof u.total_tokens === "number" && u.total_tokens > 0)) failures.push(`usage.total_tokens not > 0: ${u.total_tokens}`);
      }

      const helloPath = join(workspace, "hello.txt");
      if (!existsSync(helloPath)) {
        failures.push(`hello.txt does not exist at ${helloPath}`);
      } else {
        const body = readFileSync(helloPath, "utf8");
        if (!body.toLowerCase().includes("hi")) failures.push(`hello.txt does not contain "hi": ${JSON.stringify(body)}`);
        else console.log(`[smoke] hello.txt content: ${JSON.stringify(body)}`);
      }

      const sawSessionStarted = events.some((e) => e.event === "session_started");
      const sawTurnCompleted = events.some((e) => e.event === "turn_completed");
      if (!sawSessionStarted) failures.push("no session_started event observed");
      if (!sawTurnCompleted) failures.push("no turn_completed event observed");
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
