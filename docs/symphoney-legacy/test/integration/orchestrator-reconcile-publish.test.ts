import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { buildSnapshot, type ConfigSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import type { PublishPullRequest } from "../../src/publisher/pr.js";
import { makeFakeAgentClient } from "../../src/agent/fake-client.js";
import { makeFakeTracker, makeIssue } from "../helpers/fake-tracker.js";

function buildSnap(
  root: string,
  opts: { maxConcurrent?: number; stallTimeoutMs?: number } = {},
): ConfigSnapshot {
  const max = opts.maxConcurrent ?? 2;
  const stall = opts.stallTimeoutMs ?? 0;
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
polling:
  interval_ms: 1000000
agent:
  max_concurrent_agents: ${max}
  max_turns: 3
codex:
  command: codex app-server
  turn_timeout_ms: 5000
  read_timeout_ms: 1000
  stall_timeout_ms: ${stall}
workspace:
  root: ${root}`;
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody for {{ issue.identifier }}\n`);
  return buildSnapshot(join(root, "WORKFLOW.md"), def, { K: "tok" } as NodeJS.ProcessEnv);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const ok = await predicate();
    if (ok) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const silentLogger = pino({ level: "silent" });

describe("reconcile-terminal publishes BEFORE removing workspace (Phase 0 bug fix)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sym-reconcile-pub-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("calls publishPullRequest before workspace removal when issue moves to terminal mid-run", async () => {
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    controller.scriptForIssue("i1", [{ kind: "stall", durationMs: 200 }]);

    const callOrder: string[] = [];
    const publishSpy = vi.fn<PublishPullRequest>(async () => {
      callOrder.push("publish");
      return { url: "https://github.com/Ddell12/symphoney-codex/pull/999" };
    });
    const baseWorkspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const workspaces = {
      ...baseWorkspaces,
      removeForIssue: vi.fn(async (...args: Parameters<typeof baseWorkspaces.removeForIssue>) => {
        callOrder.push("remove");
        return baseWorkspaces.removeForIssue(...args);
      }),
    };

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
      publishPullRequest: publishSpy,
    });

    await orch.runTick();
    expect(orch.internalState.running.has("i1")).toBe(true);

    // Wait until session is up and the worktree exists
    const wsPath = join(root, "MT-1");
    await waitFor(async () => {
      const s = await stat(wsPath).catch(() => null);
      return s !== null && (controller.startedSessions.get("i1") ?? 0) > 0;
    });

    // Simulate the agent moving the issue to terminal — exactly the APP-273 scenario
    controls.patchIssue("i1", { state: "Done" });
    await orch.reconcileRunningIssues(snapshot);

    const entry = orch.internalState.running.get("i1");
    if (entry?.worker_promise) await entry.worker_promise.catch(() => {});

    // Wait for the cleanup promise chain to settle
    await waitFor(async () => callOrder.length >= 2, 6000);

    expect(callOrder).toEqual(["publish", "remove"]);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(entry?.publish_result).toBe("https://github.com/Ddell12/symphoney-codex/pull/999");

    await orch.stop();
  });

  it("does NOT remove workspace when publishPullRequest throws (preserves uncommitted work)", async () => {
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-2", state: "In Progress" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    controller.scriptForIssue("i1", [{ kind: "stall", durationMs: 200 }]);

    const publishSpy = vi.fn<PublishPullRequest>(async () => {
      throw Object.assign(new Error("dirty"), { code: "dirty_workspace" });
    });
    const baseWorkspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const removeSpy = vi.fn(baseWorkspaces.removeForIssue);
    const workspaces = { ...baseWorkspaces, removeForIssue: removeSpy };

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
      publishPullRequest: publishSpy,
    });

    await orch.runTick();
    const wsPath = join(root, "MT-2");
    await waitFor(async () => {
      const s = await stat(wsPath).catch(() => null);
      return s !== null && (controller.startedSessions.get("i1") ?? 0) > 0;
    });

    controls.patchIssue("i1", { state: "Done" });
    await orch.reconcileRunningIssues(snapshot);

    const entry = orch.internalState.running.get("i1");
    if (entry?.worker_promise) await entry.worker_promise.catch(() => {});

    // Settle the cleanup-attempt chain
    await new Promise((r) => setTimeout(r, 250));

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();
    // Workspace must still exist — human has to triage uncommitted state
    const stillThere = await stat(wsPath).catch(() => null);
    expect(stillThere).not.toBeNull();
    expect(entry?.publish_result).toMatch(/^failed:/);

    await orch.stop();
  });

  it("skips publish (and still cleans up) when publish_result is already set from success path", async () => {
    // Dedup case: worker exited normally and called publish; THEN reconcile runs.
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-3", state: "In Progress" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    controller.scriptForIssue("i1", [{ kind: "complete" }]);

    const publishSpy = vi.fn<PublishPullRequest>(async () => ({ url: "https://github.com/x/y/pull/1" }));
    const baseWorkspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const removeSpy = vi.fn(baseWorkspaces.removeForIssue);
    const workspaces = { ...baseWorkspaces, removeForIssue: removeSpy };

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
      publishPullRequest: publishSpy,
    });

    await orch.runTick();
    const entry = orch.internalState.running.get("i1");
    if (entry?.worker_promise) await entry.worker_promise; // success path runs publish once

    expect(publishSpy).toHaveBeenCalledTimes(1);

    // Now move to terminal and reconcile — should NOT publish again
    controls.patchIssue("i1", { state: "Done" });
    await orch.reconcileRunningIssues(snapshot);
    await new Promise((r) => setTimeout(r, 100));

    expect(publishSpy).toHaveBeenCalledTimes(1); // still 1 — no double-publish
    await orch.stop();
  });
});
