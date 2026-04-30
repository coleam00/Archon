import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { buildSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { resolveEnvIndirection, expandEnvAndHome } from "../../src/config/coerce.js";

describe("resolveEnvIndirection", () => {
  it("returns env value for $VAR form", () => {
    expect(resolveEnvIndirection("$X", { X: "secret" })).toBe("secret");
    expect(resolveEnvIndirection("${X}", { X: "secret" })).toBe("secret");
  });
  it("returns literal when not a $VAR pattern", () => {
    expect(resolveEnvIndirection("literal", {})).toBe("literal");
  });
  it("returns empty string when env missing", () => {
    expect(resolveEnvIndirection("$MISSING", {})).toBe("");
  });
});

describe("expandEnvAndHome", () => {
  it("expands ~/path", () => {
    const out = expandEnvAndHome("~/foo");
    expect(out).toBe(`${homedir()}/foo`);
  });
  it("expands $VAR inline", () => {
    expect(expandEnvAndHome("/data/$NAME/x", { NAME: "ws" })).toBe("/data/ws/x");
  });
});

describe("buildSnapshot", () => {
  const baseEnv = { LINEAR_API_KEY: "secret-token", HOME: "/tmp" };

  it("applies all defaults when front matter is empty", () => {
    const def = parseWorkflowContent("body\n");
    const snap = buildSnapshot("/some/path/WORKFLOW.md", def, baseEnv as NodeJS.ProcessEnv);
    expect(snap.polling.interval_ms).toBe(30_000);
    expect(snap.agent.max_concurrent_agents).toBe(10);
    expect(snap.agent.max_turns).toBe(20);
    expect(snap.agent.max_retry_backoff_ms).toBe(300_000);
    expect(snap.codex.command).toBe("codex app-server");
    expect(snap.codex.turn_timeout_ms).toBe(3_600_000);
    expect(snap.codex.read_timeout_ms).toBe(5_000);
    expect(snap.codex.stall_timeout_ms).toBe(300_000);
    expect(snap.hooks.timeout_ms).toBe(60_000);
    expect(snap.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(snap.tracker.terminal_states).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(snap.workspace.root).toBe(join(tmpdir(), "symphony_workspaces"));
  });

  it("resolves $VAR for tracker.api_key", () => {
    const def = parseWorkflowContent(
      "---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: my-slug\n---\nbody\n",
    );
    const snap = buildSnapshot("/a/WORKFLOW.md", def, baseEnv as NodeJS.ProcessEnv);
    expect(snap.tracker.api_key).toBe("secret-token");
    expect(snap.tracker.kind).toBe("linear");
    expect(snap.tracker.project_slug).toBe("my-slug");
    expect(snap.tracker.endpoint).toBe("https://api.linear.app/graphql");
  });

  it("expands ~ and resolves relative paths against workflow dir", () => {
    const def1 = parseWorkflowContent(
      "---\nworkspace:\n  root: ~/sym-ws\n---\nbody\n",
    );
    const snap1 = buildSnapshot("/a/WORKFLOW.md", def1, baseEnv as NodeJS.ProcessEnv);
    expect(snap1.workspace.root).toBe(`${homedir()}/sym-ws`);

    const def2 = parseWorkflowContent(
      "---\nworkspace:\n  root: ./relative\n---\nbody\n",
    );
    const snap2 = buildSnapshot("/a/WORKFLOW.md", def2, baseEnv as NodeJS.ProcessEnv);
    expect(snap2.workspace.root).toBe(`/a${sep}relative`);
  });

  it("normalizes per-state caps to lowercase keys", () => {
    const def = parseWorkflowContent(
      "---\nagent:\n  max_concurrent_agents_by_state:\n    'In Progress': 2\n    Todo: 5\n---\nbody\n",
    );
    const snap = buildSnapshot("/a/WORKFLOW.md", def);
    expect(snap.agent.max_concurrent_agents_by_state).toEqual({
      "in progress": 2,
      todo: 5,
    });
  });

  it("preserves codex.command as a shell string", () => {
    const def = parseWorkflowContent(
      "---\ncodex:\n  command: codex app-server --verbose\n---\nbody\n",
    );
    const snap = buildSnapshot("/a/WORKFLOW.md", def);
    expect(snap.codex.command).toBe("codex app-server --verbose");
  });

  it("allows codex.stall_timeout_ms <= 0 (disabled stall detection)", () => {
    const def = parseWorkflowContent(
      "---\ncodex:\n  stall_timeout_ms: 0\n---\nbody\n",
    );
    const snap = buildSnapshot("/a/WORKFLOW.md", def);
    expect(snap.codex.stall_timeout_ms).toBe(0);
  });
});
