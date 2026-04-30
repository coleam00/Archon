import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../src/workspace/hooks.js";

describe("runHook", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sym-hook-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("treats null script as no-op", async () => {
    const r = await runHook({ name: "before_run", script: null, cwd, timeoutMs: 1000 });
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("runs a successful script and captures stdout", async () => {
    const r = await runHook({
      name: "before_run",
      script: "echo hello",
      cwd,
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("surfaces a non-zero exit as ok=false", async () => {
    const r = await runHook({
      name: "before_run",
      script: "exit 3",
      cwd,
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it("kills a script that exceeds the timeout", async () => {
    const r = await runHook({
      name: "before_run",
      script: "sleep 5",
      cwd,
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("runs in the provided cwd", async () => {
    const r = await runHook({
      name: "after_create",
      script: "pwd > pwd.txt",
      cwd,
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    const out = await readFile(join(cwd, "pwd.txt"), "utf8");
    const resolvedCwd = await realpath(cwd);
    expect(out.trim()).toBe(resolvedCwd);
  });

  it("forwards hook env vars (WORKSPACE_PATH, ISSUE_IDENTIFIER, ATTEMPT, WORKFLOW_PATH)", async () => {
    const r = await runHook({
      name: "before_run",
      script: 'printf "%s|%s|%s|%s\\n" "$WORKSPACE_PATH" "$ISSUE_IDENTIFIER" "$ATTEMPT" "$WORKFLOW_PATH"',
      cwd,
      timeoutMs: 5000,
      env: {
        WORKSPACE_PATH: "/tmp/abc",
        ISSUE_IDENTIFIER: "ENG-9",
        ISSUE_ID: "id-9",
        ISSUE_TITLE: "Fix the thing",
        ATTEMPT: "0",
        WORKFLOW_PATH: "/tmp/WORKFLOW.md",
      },
    });
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("/tmp/abc|ENG-9|0|/tmp/WORKFLOW.md");
  });
});
