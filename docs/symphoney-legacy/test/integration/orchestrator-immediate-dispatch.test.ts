import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { buildSnapshot, type ConfigSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { makeFakeAgentClient } from "../../src/agent/fake-client.js";
import { makeFakeTracker, makeIssue } from "../helpers/fake-tracker.js";

function buildSnap(root: string, maxConcurrent = 2): ConfigSnapshot {
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
polling:
  interval_ms: 1000000
agent:
  max_concurrent_agents: ${maxConcurrent}
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

const silentLogger = pino({ level: "silent" });

describe("Orchestrator.requestImmediateDispatch", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sym-imm-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns ok and adds the issue to running when eligible", async () => {
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" });
    const { tracker } = makeFakeTracker([issue]);
    const { client } = makeFakeAgentClient();
    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
    });
    try {
      const r = await orch.requestImmediateDispatch("MT-1");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.issue_id).toBe("i1");
      const snap = orch.getSnapshot();
      expect(snap.counts.running).toBe(1);
      expect(snap.running[0]?.issue_identifier).toBe("MT-1");
    } finally {
      await orch.stop();
    }
  });

  it("returns 404-style reason when issue is not in active states", async () => {
    const snapshot = buildSnap(root);
    const { tracker } = makeFakeTracker([]);
    const { client } = makeFakeAgentClient();
    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
    });
    try {
      const r = await orch.requestImmediateDispatch("NOPE-1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/issue not found/);
    } finally {
      await orch.stop();
    }
  });

  it("rejects with reason when global slot cap is full", async () => {
    const snapshot = buildSnap(root, 1);
    const a = makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" });
    const b = makeIssue({ id: "i2", identifier: "MT-2", state: "Todo" });
    const { tracker } = makeFakeTracker([a, b]);
    const { client } = makeFakeAgentClient();
    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
    });
    try {
      const first = await orch.requestImmediateDispatch("MT-1");
      expect(first.ok).toBe(true);
      const second = await orch.requestImmediateDispatch("MT-2");
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toMatch(/no global slots/);
    } finally {
      await orch.stop();
    }
  });

  it("rejects when issue is already running (de-dupe)", async () => {
    const snapshot = buildSnap(root);
    const a = makeIssue({ id: "i1", identifier: "MT-1", state: "Todo" });
    const { tracker } = makeFakeTracker([a]);
    const { client } = makeFakeAgentClient();
    const workspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
    });
    try {
      const first = await orch.requestImmediateDispatch("MT-1");
      expect(first.ok).toBe(true);
      const second = await orch.requestImmediateDispatch("MT-1");
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toMatch(/already running/);
    } finally {
      await orch.stop();
    }
  });
});
