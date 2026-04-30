import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { startHttpServer, type RunningHttpServer } from "../../src/server/http.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { buildSnapshot, type ConfigSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { makeFakeAgentClient, type FakeAgentController } from "../../src/agent/fake-client.js";
import { makeFakeTracker, makeIssue } from "../helpers/fake-tracker.js";

const silentLogger = pino({ level: "silent" });

function buildSnap(root: string): ConfigSnapshot {
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
polling:
  interval_ms: 1000000
agent:
  max_concurrent_agents: 2
  max_turns: 1
codex:
  command: codex app-server
  turn_timeout_ms: 5000
  read_timeout_ms: 1000
  stall_timeout_ms: 0
workspace:
  root: ${root}`;
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody\n`);
  return buildSnapshot(join(root, "WORKFLOW.md"), def, { K: "tok" } as NodeJS.ProcessEnv);
}

describe("http server", () => {
  let root: string;
  let server: RunningHttpServer;
  let orchestrator: Orchestrator;
  let agentController: FakeAgentController;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sym-http-"));
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" });
    const { tracker } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    agentController = controller;
    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    orchestrator = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
    });
    server = await startHttpServer({
      orchestrator,
      tracker,
      getSnapshot: () => snapshot,
      logger: silentLogger,
      port: 0,
      host: "127.0.0.1",
    });
  });

  afterEach(async () => {
    await orchestrator.stop();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it("serves the dashboard at /", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html/);
    expect(html).toContain("Symphony");
  });

  it("serves /api/v1/state with the suggested shape", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("generated_at");
    expect(body).toHaveProperty("counts");
    expect(body).toHaveProperty("running");
    expect(body).toHaveProperty("retrying");
    expect(body).toHaveProperty("codex_totals");
    expect((body.codex_totals as Record<string, unknown>).total_tokens).toBe(0);
  });

  it("returns 404 for unknown issue identifier", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/MT-NONE`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("accepts POST /api/v1/refresh and reports queued=true", async () => {
    const r1 = await fetch(`http://127.0.0.1:${server.port}/api/v1/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r1.status).toBe(202);
    const b1 = (await r1.json()) as {
      queued: boolean;
      coalesced: boolean;
      operations: string[];
    };
    expect(b1.queued).toBe(true);
    expect(b1.operations).toEqual(["poll", "reconcile"]);

    const r2 = await fetch(`http://127.0.0.1:${server.port}/api/v1/refresh`, {
      method: "POST",
      body: "",
    });
    expect(r2.status).toBe(202);
    const b2 = (await r2.json()) as { queued: boolean };
    expect(b2.queued).toBe(true);
  });

  it("returns 405 on unsupported methods", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/refresh`);
    expect(res.status).toBe(405);
  });

  it("serves /api/v1/issues with serialized tracker issues", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/issues`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generated_at: string;
      issues: Array<{ identifier: string; state: string; created_at: string | null }>;
    };
    expect(typeof body.generated_at).toBe("string");
    expect(body.issues.length).toBe(1);
    expect(body.issues[0]?.identifier).toBe("MT-1");
    expect(body.issues[0]?.state).toBe("Todo");
    // Date fields are ISO strings, not Date instances.
    expect(typeof body.issues[0]?.created_at).toBe("string");
  });

  it("returns empty issues when ?states= filters out everything", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/issues?states=NotARealState`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues).toEqual([]);
  });

  it("serves /api/v1/repositories empty when no repository configured", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/repositories`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: unknown[] };
    expect(body.repositories).toEqual([]);
  });

  it("POST /api/v1/dispatch with unknown identifier returns 404 with structured code", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue_identifier: "NOPE-1" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found_in_active_states");
    expect(body.error.message).toMatch(/not found/);
  });

  it("POST /api/v1/dispatch without body returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/dispatch`, {
      method: "POST",
      body: "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("POST /api/v1/dispatch with eligible identifier returns 202 and updates snapshot", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue_identifier: "MT-1" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      dispatched: boolean;
      issue_identifier: string;
      issue_id: string;
    };
    expect(body.dispatched).toBe(true);
    expect(body.issue_identifier).toBe("MT-1");
    expect(body.issue_id).toBe("i1");

    // Snapshot should now reflect the dispatched issue.
    const stateRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/state`);
    const stateBody = (await stateRes.json()) as {
      counts: { running: number };
      running: Array<{ issue_identifier: string }>;
    };
    expect(stateBody.counts.running).toBe(1);
    expect(stateBody.running[0]?.issue_identifier).toBe("MT-1");
  });

  it("GET /api/v1/dispatch returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/dispatch`);
    expect(res.status).toBe(405);
  });

  it("GET /api/v1/version reports package version and start time", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; started_at: string };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof body.started_at).toBe("string");
    expect(() => new Date(body.started_at).toISOString()).not.toThrow();
  });

  it("GET /api/v1/issues honors ?limit= and rejects bad values", async () => {
    const ok = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/issues?limit=0`,
    );
    expect(ok.status).toBe(400);

    const limited = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/issues?limit=1`,
    );
    expect(limited.status).toBe(200);
    const body = (await limited.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeLessThanOrEqual(1);
  });

  it("POST /api/v1/<id>/cancel returns 404 when not running", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/MT-NONE/cancel`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_running");
  });

  it("POST /api/v1/<id>/cancel aborts a running issue and skips auto-retry", async () => {
    // Keep the worker alive long enough to cancel.
    agentController.scriptForIssue("i1", [
      { kind: "stall", durationMs: 5_000 },
    ]);

    const dispatch = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issue_identifier: "MT-1" }),
      },
    );
    expect(dispatch.status).toBe(202);

    const cancel = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/MT-1/cancel`,
      { method: "POST" },
    );
    expect(cancel.status).toBe(202);
    const body = (await cancel.json()) as {
      cancelled: boolean;
      issue_identifier: string;
      issue_id: string;
    };
    expect(body.cancelled).toBe(true);
    expect(body.issue_identifier).toBe("MT-1");
    expect(body.issue_id).toBe("i1");

    // After cancel, the worker is wound down and NOT auto-retried.
    // Wait for the worker_promise chain to settle (worker rejects with "aborted",
    // onWorkerExit removes the entry, cancel_requested suppresses retry).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(orchestrator.internalState.running.has("i1")).toBe(false);
    expect(orchestrator.internalState.retry_attempts.has("i1")).toBe(false);
  });
});

