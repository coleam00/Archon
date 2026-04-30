import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { Issue, Tracker } from "../tracker/types.js";

const execFile = promisify(execFileCallback);

export type PrPublishCode =
  | "wrong_branch"
  | "dirty_workspace"
  | "typecheck_failed"
  | "gh_unauth"
  | "git_push_failed"
  | "gh_create_failed"
  | "missing_url";

export class PrPublishError extends Error {
  constructor(
    public readonly code: PrPublishCode,
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "PrPublishError";
  }
}

export interface PublishResult {
  /** PR URL if a PR was published. */
  url?: string;
  /** Set when there were no commits ahead of origin/main; nothing was pushed. */
  skipped?: "no_changes";
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellRunner {
  (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult>;
}

export interface PublishPullRequestInput {
  workspacePath: string;
  issue: Issue;
  tracker: Tracker;
  log: Logger;
  /** Optional `owner/repo` shorthand (passed through to `gh pr create --repo`). */
  repository?: string | null;
  /** Per-step shell timeout in ms. Default 5min. */
  shellTimeoutMs?: number;
  /** Test injection point. */
  runShell?: ShellRunner;
}

export type PublishPullRequest = (input: PublishPullRequestInput) => Promise<PublishResult>;

const defaultShell: ShellRunner = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : err.message,
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
};

/**
 * Parse a PR URL out of `gh pr create --fill` stdout.
 * `gh` prints the URL on its own line; pick the last `https://github.com/...` token.
 */
function extractPrUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/[^\s]+/g);
  return match && match.length > 0 ? (match[match.length - 1] ?? null) : null;
}

/**
 * Publish a pull request from a per-issue worktree.
 *
 * Contract (Wave 0.6):
 * - Verify the worktree is on branch `sym/<identifier>`.
 * - Refuse on dirty working tree.
 * - Skip cleanly with `{ skipped: "no_changes" }` if nothing is ahead of origin/main.
 * - Run `pnpm typecheck` before pushing.
 * - Push branch, open PR via `gh pr create --fill`, parse PR URL from stdout.
 * - Best-effort post a Linear comment with the PR URL (failures logged, not thrown).
 *
 * Throws `PrPublishError` (with a stable `code`) on every other failure mode.
 */
export const publishPullRequest: PublishPullRequest = async (input) => {
  const run = input.runShell ?? defaultShell;
  const cwd = input.workspacePath;
  const branch = `sym/${input.issue.identifier}`;
  const log = input.log.child({
    issue_id: input.issue.id,
    issue_identifier: input.issue.identifier,
  });

  // 1. Branch check.
  const headRes = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (headRes.exitCode !== 0) {
    throw new PrPublishError(
      "wrong_branch",
      `git rev-parse failed: ${headRes.stderr.trim()}`,
      headRes.stderr,
    );
  }
  const head = headRes.stdout.trim();
  if (head !== branch) {
    throw new PrPublishError(
      "wrong_branch",
      `expected branch ${branch} but workspace HEAD is ${head}`,
    );
  }

  // 2. Clean working tree.
  const statusRes = await run("git", ["status", "--porcelain"], { cwd });
  if (statusRes.exitCode !== 0) {
    throw new PrPublishError(
      "dirty_workspace",
      `git status failed: ${statusRes.stderr.trim()}`,
      statusRes.stderr,
    );
  }
  if (statusRes.stdout.trim().length > 0) {
    throw new PrPublishError(
      "dirty_workspace",
      `workspace has uncommitted changes:\n${statusRes.stdout.trim()}`,
    );
  }

  // 3. Anything to push?
  const aheadRes = await run("git", ["log", "origin/main..HEAD", "--oneline"], { cwd });
  if (aheadRes.exitCode !== 0) {
    throw new PrPublishError(
      "git_push_failed",
      `git log origin/main..HEAD failed: ${aheadRes.stderr.trim()}`,
      aheadRes.stderr,
    );
  }
  if (aheadRes.stdout.trim().length === 0) {
    log.warn("pr_publish_no_changes");
    return { skipped: "no_changes" };
  }

  // 4. Typecheck gate.
  const tcRes = await run("pnpm", ["--dir", cwd, "typecheck"], {
    cwd,
    timeoutMs: input.shellTimeoutMs ?? 10 * 60_000,
  });
  if (tcRes.exitCode !== 0) {
    throw new PrPublishError(
      "typecheck_failed",
      `pnpm typecheck failed (exit=${tcRes.exitCode})`,
      tcRes.stderr || tcRes.stdout,
    );
  }

  // 5. gh auth.
  const authRes = await run("gh", ["auth", "status"], { cwd });
  if (authRes.exitCode !== 0) {
    throw new PrPublishError(
      "gh_unauth",
      "gh CLI is not authenticated; run `gh auth login` on the daemon host",
      authRes.stderr,
    );
  }

  // 6. Push.
  const pushRes = await run("git", ["push", "-u", "origin", branch], { cwd });
  if (pushRes.exitCode !== 0) {
    throw new PrPublishError(
      "git_push_failed",
      `git push -u origin ${branch} failed (exit=${pushRes.exitCode})`,
      pushRes.stderr,
    );
  }

  // 7. Create PR.
  const prArgs = [
    "pr",
    "create",
    "--fill",
    "--base",
    "main",
    "--head",
    branch,
    "--body",
    `Fixes ${input.issue.identifier}\n\nDispatched by Symphony.`,
  ];
  if (input.repository) {
    prArgs.push("--repo", input.repository);
  }
  const prRes = await run("gh", prArgs, { cwd });
  if (prRes.exitCode !== 0) {
    throw new PrPublishError(
      "gh_create_failed",
      `gh pr create failed (exit=${prRes.exitCode})`,
      prRes.stderr || prRes.stdout,
    );
  }

  const url = extractPrUrl(prRes.stdout);
  if (!url) {
    throw new PrPublishError(
      "missing_url",
      `gh pr create succeeded but no PR URL in stdout: ${prRes.stdout.trim()}`,
    );
  }

  log.info({ pr_url: url }, "pr_published");

  // 8. Best-effort backlink.
  try {
    if (typeof input.tracker.commentOnIssue === "function") {
      await input.tracker.commentOnIssue({
        issueId: input.issue.id,
        body: `Symphony dispatch published: ${url}`,
      });
    } else {
      log.warn("tracker_comment_unsupported");
    }
  } catch (e) {
    log.error(
      { err: (e as Error).message, pr_url: url },
      "pr_publish_comment_failed",
    );
  }

  return { url };
};
