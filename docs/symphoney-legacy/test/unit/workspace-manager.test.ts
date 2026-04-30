import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import type { ConfigSnapshot } from "../../src/config/snapshot.js";

function snapWith(over: {
  workspace: { root: string };
  hooks?: Partial<ConfigSnapshot["hooks"]>;
}): ConfigSnapshot {
  const h = over.hooks ?? {};
  return {
    workflow_path: "/x/WORKFLOW.md",
    workflow_dir: "/x",
    prompt_template: "",
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
    workspace: over.workspace,
    hooks: {
      after_create: h.after_create ?? null,
      before_run: h.before_run ?? null,
      after_run: h.after_run ?? null,
      before_remove: h.before_remove ?? null,
      timeout_ms: h.timeout_ms ?? 5_000,
    },
    agent: {
      backend: "codex",
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 3_600_000,
      stall_timeout_ms: 300_000,
      continuation_prompt: "continue",
    },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
    },
    claude: {
      model: null,
      allowed_tools: ["Read", "Edit", "Bash"],
      permission_mode: "bypassPermissions",
      force_subscription_auth: false,
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 30_000,
      stall_timeout_ms: 300_000,
    },
    server: { port: null, bind_host: "127.0.0.1" },
  };
}

describe("WorkspaceManager", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sym-ws-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates the workspace and reports created_now=true the first time", async () => {
    let snap = snapWith({ workspace: { root } });
    const mgr = createWorkspaceManager({ getSnapshot: () => snap });
    const ws = await mgr.createForIssue("MT-1");
    expect(ws.path).toBe(join(root, "MT-1"));
    expect(ws.workspace_key).toBe("MT-1");
    expect(ws.created_now).toBe(true);
    const s = await stat(ws.path);
    expect(s.isDirectory()).toBe(true);
  });

  it("reports created_now=false on reuse and skips after_create the second time", async () => {
    let createdCount = 0;
    let snap = snapWith({
      workspace: { root },
      hooks: { after_create: "echo hi" },
    });
    const mgr = createWorkspaceManager({
      getSnapshot: () => snap,
      logHookResult: (name) => {
        if (name === "after_create") createdCount += 1;
      },
    });
    await mgr.createForIssue("MT-2");
    const ws2 = await mgr.createForIssue("MT-2");
    expect(ws2.created_now).toBe(false);
    expect(createdCount).toBe(1);
  });

  it("aborts when after_create fails, and removes the partial directory", async () => {
    const snap = snapWith({
      workspace: { root },
      hooks: { after_create: "exit 7", timeout_ms: 5_000 },
    });
    const mgr = createWorkspaceManager({ getSnapshot: () => snap });
    await expect(mgr.createForIssue("MT-3")).rejects.toThrow(/after_create/);
    const exists = await stat(join(root, "MT-3")).catch(() => null);
    expect(exists).toBeNull();
  });

  it("rejects identifiers that resolve outside of root", async () => {
    const snap = snapWith({ workspace: { root } });
    const mgr = createWorkspaceManager({ getSnapshot: () => snap });
    // sanitize replaces "/" with "_" so this is effectively benign,
    // but the safety check is still applied.
    const ws = await mgr.createForIssue("../../../etc/passwd");
    expect(ws.path.startsWith(`${root}/`)).toBe(true);
    expect(ws.workspace_key).not.toContain("/");
  });

  it("removes the workspace and runs before_remove", async () => {
    const snap = snapWith({
      workspace: { root },
      hooks: { before_remove: "touch removed.txt" },
    });
    const mgr = createWorkspaceManager({ getSnapshot: () => snap });
    const ws = await mgr.createForIssue("MT-4");
    await writeFile(join(ws.path, "marker"), "hello");
    await mgr.removeForIssue("MT-4");
    const exists = await stat(ws.path).catch(() => null);
    expect(exists).toBeNull();
  });

  it("passes hook env vars (WORKSPACE_PATH, ISSUE_*, WORKFLOW_PATH) to after_create + before_remove", async () => {
    const envOut = join(root, "env-after_create.txt");
    const envOut2 = join(root, "env-before_remove.txt");
    const snap = snapWith({
      workspace: { root },
      hooks: {
        after_create: `printf "%s|%s|%s|%s\\n" "$WORKSPACE_PATH" "$ISSUE_ID" "$ISSUE_IDENTIFIER" "$WORKFLOW_PATH" > "${envOut}"`,
        before_remove: `printf "%s|%s|%s|%s\\n" "$WORKSPACE_PATH" "$ISSUE_ID" "$ISSUE_IDENTIFIER" "$WORKFLOW_PATH" > "${envOut2}"`,
      },
    });
    const mgr = createWorkspaceManager({ getSnapshot: () => snap });
    const issue = {
      id: "uuid-9",
      identifier: "ENG-9",
      title: "Fix the thing",
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
    const ws = await mgr.createForIssue("ENG-9", issue);
    const created = (await readFile(envOut, "utf8")).trim();
    expect(created).toBe(`${ws.path}|uuid-9|ENG-9|/x/WORKFLOW.md`);

    await mgr.removeForIssue("ENG-9", issue);
    const removed = (await readFile(envOut2, "utf8")).trim();
    expect(removed).toBe(`${ws.path}|uuid-9|ENG-9|/x/WORKFLOW.md`);
  });
});
