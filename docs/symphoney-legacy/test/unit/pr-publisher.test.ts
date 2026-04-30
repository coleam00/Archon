import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { publishPullRequest, PrPublishError, type ShellRunner } from "../../src/publisher/pr.js";
import type { Issue, Tracker } from "../../src/tracker/types.js";

const silentLogger = pino({ level: "silent" });

function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "uuid-1",
    identifier: "ENG-1",
    title: "Add a README",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...over,
  };
}

function makeTracker(over: Partial<Tracker> = {}): Tracker {
  return {
    fetchCandidateIssues: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchIssuesByStates: async () => [],
    ...over,
  };
}

/** Build a recording shell stub from an array of (cmd, args)→result responders, in order. */
function makeShellSequence(
  responders: Array<(cmd: string, args: string[]) => { stdout?: string; stderr?: string; exitCode?: number }>,
): { run: ShellRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const run: ShellRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    const fn = responders[i++];
    if (!fn) throw new Error(`unexpected shell call: ${cmd} ${args.join(" ")}`);
    const res = fn(cmd, args);
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.exitCode ?? 0 };
  };
  return { run, calls };
}

describe("publishPullRequest", () => {
  it("happy path: pushes branch, opens PR, posts Linear comment", async () => {
    const commentSpy = vi.fn(async () => ({ id: "comment-1" }));
    const tracker = makeTracker({ commentOnIssue: commentSpy });

    const { run, calls } = makeShellSequence([
      // 1. git rev-parse
      () => ({ stdout: "sym/ENG-1\n" }),
      // 2. git status --porcelain → clean
      () => ({ stdout: "" }),
      // 3. git log origin/main..HEAD
      () => ({ stdout: "abc1234 Add the README\n" }),
      // 4. pnpm typecheck
      () => ({ stdout: "all good" }),
      // 5. gh auth status
      () => ({ stdout: "Logged in" }),
      // 6. git push
      () => ({ stdout: "" }),
      // 7. gh pr create
      () => ({
        stdout: "https://github.com/Ddell12/symphoney-codex/pull/42\n",
      }),
    ]);

    const result = await publishPullRequest({
      workspacePath: "/tmp/ws",
      issue: makeIssue(),
      tracker,
      log: silentLogger,
      runShell: run,
      repository: "Ddell12/symphoney-codex",
    });

    expect(result.url).toBe("https://github.com/Ddell12/symphoney-codex/pull/42");
    expect(result.skipped).toBeUndefined();
    expect(commentSpy).toHaveBeenCalledWith({
      issueId: "uuid-1",
      body: "Symphony dispatch published: https://github.com/Ddell12/symphoney-codex/pull/42",
    });
    // gh pr create should include --repo when set
    expect(calls[6]?.args).toContain("--repo");
    expect(calls[6]?.args).toContain("Ddell12/symphoney-codex");
  });

  it("returns skipped:no_changes when nothing is ahead of origin/main", async () => {
    const commentSpy = vi.fn();
    const tracker = makeTracker({ commentOnIssue: commentSpy });

    const { run } = makeShellSequence([
      () => ({ stdout: "sym/ENG-1\n" }), // rev-parse
      () => ({ stdout: "" }), // status clean
      () => ({ stdout: "" }), // git log empty
    ]);

    const result = await publishPullRequest({
      workspacePath: "/tmp/ws",
      issue: makeIssue(),
      tracker,
      log: silentLogger,
      runShell: run,
    });

    expect(result.skipped).toBe("no_changes");
    expect(result.url).toBeUndefined();
    expect(commentSpy).not.toHaveBeenCalled();
  });

  it("throws wrong_branch when HEAD does not match sym/<identifier>", async () => {
    const { run } = makeShellSequence([() => ({ stdout: "main\n" })]);
    await expect(
      publishPullRequest({
        workspacePath: "/tmp/ws",
        issue: makeIssue(),
        tracker: makeTracker(),
        log: silentLogger,
        runShell: run,
      }),
    ).rejects.toMatchObject({ name: "PrPublishError", code: "wrong_branch" });
  });

  it("throws dirty_workspace when status --porcelain has output", async () => {
    const { run } = makeShellSequence([
      () => ({ stdout: "sym/ENG-1\n" }),
      () => ({ stdout: " M src/foo.ts\n" }),
    ]);
    await expect(
      publishPullRequest({
        workspacePath: "/tmp/ws",
        issue: makeIssue(),
        tracker: makeTracker(),
        log: silentLogger,
        runShell: run,
      }),
    ).rejects.toMatchObject({ name: "PrPublishError", code: "dirty_workspace" });
  });

  it("throws typecheck_failed when pnpm typecheck exits non-zero", async () => {
    const { run } = makeShellSequence([
      () => ({ stdout: "sym/ENG-1\n" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "abc1234 Add the README\n" }),
      () => ({ exitCode: 2, stderr: "Type error in foo.ts" }),
    ]);
    await expect(
      publishPullRequest({
        workspacePath: "/tmp/ws",
        issue: makeIssue(),
        tracker: makeTracker(),
        log: silentLogger,
        runShell: run,
      }),
    ).rejects.toMatchObject({ name: "PrPublishError", code: "typecheck_failed" });
  });

  it("throws gh_unauth when gh auth status fails", async () => {
    const { run } = makeShellSequence([
      () => ({ stdout: "sym/ENG-1\n" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "abc1234 Add the README\n" }),
      () => ({ stdout: "all good" }),
      () => ({ exitCode: 1, stderr: "not logged in" }),
    ]);
    await expect(
      publishPullRequest({
        workspacePath: "/tmp/ws",
        issue: makeIssue(),
        tracker: makeTracker(),
        log: silentLogger,
        runShell: run,
      }),
    ).rejects.toMatchObject({ name: "PrPublishError", code: "gh_unauth" });
  });

  it("throws missing_url when gh pr create succeeds with no URL in stdout", async () => {
    const { run } = makeShellSequence([
      () => ({ stdout: "sym/ENG-1\n" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "abc1234 Add the README\n" }),
      () => ({ stdout: "ok" }),
      () => ({ stdout: "Logged in" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "Created PR (no URL)\n" }),
    ]);
    await expect(
      publishPullRequest({
        workspacePath: "/tmp/ws",
        issue: makeIssue(),
        tracker: makeTracker(),
        log: silentLogger,
        runShell: run,
      }),
    ).rejects.toMatchObject({ name: "PrPublishError", code: "missing_url" });
  });

  it("does not throw when the Linear comment mutation fails (PR is already up)", async () => {
    const commentSpy = vi.fn(async () => {
      throw new Error("linear 503");
    });
    const tracker = makeTracker({ commentOnIssue: commentSpy });
    const { run } = makeShellSequence([
      () => ({ stdout: "sym/ENG-1\n" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "abc1234 Add the README\n" }),
      () => ({ stdout: "ok" }),
      () => ({ stdout: "Logged in" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "https://github.com/Ddell12/symphoney-codex/pull/42\n" }),
    ]);

    const result = await publishPullRequest({
      workspacePath: "/tmp/ws",
      issue: makeIssue(),
      tracker,
      log: silentLogger,
      runShell: run,
    });

    expect(result.url).toBe("https://github.com/Ddell12/symphoney-codex/pull/42");
    expect(commentSpy).toHaveBeenCalledOnce();
  });
});

// Type-only smoke check: PrPublishError is exported and instantiable.
// (Keeps the import live; the runtime tests don't construct it directly.)
void PrPublishError;
