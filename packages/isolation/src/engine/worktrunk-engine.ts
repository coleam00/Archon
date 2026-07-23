/**
 * Worktrunk Engine
 *
 * Routes worktree add/remove/list through the `wt` CLI
 * (https://worktrunk.dev) so worktrees Archon creates participate in the
 * user's worktrunk setup: per-repo hooks (env setup, dependency install) run
 * on creation and removal, and Archon-managed worktrees show up in `wt list`
 * alongside manually-created ones.
 *
 * Path pinning: worktrunk normally derives the worktree destination from its
 * own `worktree-path` template. Archon owns path layout (the environment
 * registry and log/artifact resolution depend on it), so every invocation pins
 * the destination to the exact path via `--config-set worktree-path="<literal>"`
 * — an inline TOML override with higher priority than the user's config files
 * and `WORKTRUNK_*` env vars. Branch names may contain `/`, so the literal
 * resolved path is pinned rather than a `{{ branch }}` template.
 *
 * Branch lifecycle stays with the provider: `remove` always passes
 * `--no-delete-branch` (the provider deletes branches itself, exactly as with
 * the git engine), and `wt switch --create` sets no upstream tracking —
 * matching the git engine's `--no-track` behavior.
 *
 * Failure mode: if the `wt` binary is missing or older than
 * `MIN_WORKTRUNK_VERSION`, every operation fails fast with an actionable error
 * naming the binary — no silent fallback to the git engine.
 */

import { execFileAsync } from '@archon/git';
import { toBranchName, toWorktreePath } from '@archon/git';
import type { RepoPath, WorktreeInfo } from '@archon/git';
import { createLogger } from '@archon/paths';
import type { AddWorktreeOptions, RemoveWorktreeOptions, WorktreeEngine } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.worktrunk');
  return cachedLog;
}

/**
 * Oldest worktrunk release this engine is validated against. Needs
 * `--config-set`, `--no-cd`, `--foreground`, `--no-delete-branch`, and
 * `wt list --format json` — all verified on 0.61.0.
 */
export const MIN_WORKTRUNK_VERSION = '0.61.0';

/**
 * Ceiling for a single `wt` subprocess in add/remove operations. Matches the
 * git engine's ceiling: user-configured worktrunk hooks (dependency install,
 * env setup) play the same role as heavy post-checkout hooks.
 */
const WT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

const WT_LIST_TIMEOUT_MS = 30000;
const WT_VERSION_TIMEOUT_MS = 10000;
const PRUNE_TIMEOUT_MS = 15000;

/** Shape of one `wt list --format json` entry (subset Archon reads). */
interface WtListEntry {
  branch?: string | null;
  path?: string | null;
  kind?: string;
}

/**
 * Serialize a path as a TOML basic string for `--config-set`. JSON string
 * escaping is a valid TOML basic-string encoding for the characters that can
 * appear in filesystem paths (quotes, backslashes, control chars).
 */
function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function parseWtVersion(stdout: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return match ? match[0] : null;
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(part => Number.parseInt(part, 10));
  const [maj, min, pat] = parse(version);
  const [minMaj, minMin, minPat] = parse(minimum);
  if (maj !== minMaj) return maj > minMaj;
  if (min !== minMin) return min > minMin;
  return pat >= minPat;
}

export class WorktrunkEngine implements WorktreeEngine {
  readonly id = 'worktrunk' as const;

  /** Cached successful preflight — one `wt --version` probe per process. */
  private available: Promise<void> | null = null;

  /**
   * Fail fast when `wt` is missing or too old. Only a successful probe is
   * cached, so a user can install/upgrade `wt` and retry without restarting.
   */
  private ensureAvailable(): Promise<void> {
    if (!this.available) {
      const probe = this.probeBinary();
      this.available = probe;
      probe.catch(() => {
        this.available = null;
      });
    }
    return this.available;
  }

  private async probeBinary(): Promise<void> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('wt', ['--version'], { timeout: WT_VERSION_TIMEOUT_MS }));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      getLog().error({ err, code: err.code }, 'worktrunk.binary_probe_failed');
      throw new Error(
        "worktree.engine is 'worktrunk' but the 'wt' binary was not found on PATH " +
          `(${err.code ?? err.message}). Install worktrunk (https://worktrunk.dev) ` +
          "or remove 'worktree.engine' from .archon/config.yaml to use the default git engine."
      );
    }

    const version = parseWtVersion(stdout);
    if (!version || !isVersionAtLeast(version, MIN_WORKTRUNK_VERSION)) {
      throw new Error(
        `worktree.engine is 'worktrunk' but 'wt' reported version '${version ?? stdout.trim()}', ` +
          `older than the minimum supported ${MIN_WORKTRUNK_VERSION}. Upgrade worktrunk ` +
          "(https://worktrunk.dev) or remove 'worktree.engine' from .archon/config.yaml."
      );
    }
  }

  /**
   * `wt switch --create <branch> --base <startPoint>` for a new branch;
   * `wt switch <branch>` for an existing one. `--no-cd` skips the directory
   * change (hooks still run), `--yes` skips interactive approval prompts.
   * `track` is not forwarded: `wt switch --create` never sets upstream
   * tracking (matching git `--no-track`), and callers that need tracking set
   * it explicitly afterwards (same as with the git engine).
   */
  async add(options: AddWorktreeOptions): Promise<void> {
    await this.ensureAvailable();
    const { repoPath, worktreePath, branch, startPoint } = options;
    const args = ['switch'];
    if (startPoint !== undefined) {
      args.push('--create', branch, '--base', startPoint);
    } else {
      args.push(branch);
    }
    args.push('--no-cd', '--yes', '-C', repoPath, ...pinnedPathArgs(worktreePath));
    await execFileAsync('wt', args, { timeout: WT_OPERATION_TIMEOUT_MS });
  }

  async remove(options: RemoveWorktreeOptions): Promise<void> {
    await this.ensureAvailable();
    const { repoPath, worktreePath, force } = options;
    // `--foreground` blocks until removal completes (wt removes in the
    // background by default); `--no-delete-branch` because branch deletion is
    // the provider's job — identical to the git engine's contract.
    const args = ['remove', worktreePath, '--foreground', '--no-delete-branch'];
    if (force) {
      args.push('--force');
    }
    args.push('--yes', '-C', repoPath);
    await execFileAsync('wt', args, { timeout: WT_OPERATION_TIMEOUT_MS });
  }

  async list(repoPath: RepoPath): Promise<WorktreeInfo[]> {
    await this.ensureAvailable();
    const { stdout } = await execFileAsync('wt', ['list', '--format', 'json', '-C', repoPath], {
      timeout: WT_LIST_TIMEOUT_MS,
    });

    let entries: unknown;
    try {
      entries = JSON.parse(stdout);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, repoPath }, 'worktrunk.list_parse_failed');
      throw new Error(`Failed to parse 'wt list --format json' output: ${err.message}`);
    }
    if (!Array.isArray(entries)) {
      throw new Error(
        `Unexpected 'wt list --format json' output: expected an array, got ${typeof entries}`
      );
    }

    const worktrees: WorktreeInfo[] = [];
    for (const entry of entries as WtListEntry[]) {
      // Parity with the git engine's porcelain parse: only real worktrees with
      // a branch (skips branch-only rows from config overrides and detached
      // HEADs, which the git engine also omits).
      if (entry.kind === 'worktree' && entry.branch && entry.path) {
        worktrees.push({
          path: toWorktreePath(entry.path),
          branch: toBranchName(entry.branch),
        });
      }
    }
    return worktrees;
  }

  /**
   * Worktrunk has no prune command — stale-bookkeeping cleanup is a git-gc
   * concern, and worktrunk-created worktrees are ordinary git worktrees, so
   * `git worktree prune` is the correct operation for both engines. This is an
   * intentional, documented use of git (not a fallback from a missing binary).
   */
  async prune(repoPath: RepoPath): Promise<void> {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], {
      timeout: PRUNE_TIMEOUT_MS,
    });
  }
}

/** Inline TOML override pinning the worktree destination to a literal path. */
function pinnedPathArgs(worktreePath: string): string[] {
  return ['--config-set', `worktree-path=${toTomlString(worktreePath)}`];
}
