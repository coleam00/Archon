import { canonicalizeProjectPath } from '@archon/paths';
import { statSync } from 'node:fs';
import {
  registerRepository,
  registerFolder,
  ProjectRegistrationError,
} from '@archon/core/handlers/clone';
import { InvalidCodebaseDefaultCwdError } from '@archon/core/utils/codebase-path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { ContainerBackendConfig } from '@archon/isolation';
import { getArchonHome } from '@archon/paths';
import { join } from 'node:path';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import { getLog, type WorkflowRunOptions } from './workflow-shared';

/**
 * Default runner image when `.archon/config.yaml > container.image` is unset.
 * The build script (`bun run build:runner-image`) tags both
 * `archon-runner:<version>` and `archon-runner:latest`; defaulting to `latest`
 * always matches the most recently built image without coupling to the
 * dev-vs-binary version string. Operators pin `container.image` for reproducibility.
 */
const DEFAULT_RUNNER_IMAGE = 'archon-runner:latest';

/**
 * Resolve the container backend config from the merged `container` config,
 * applying Phase B defaults (bridge network, 4 GiB memory, 512 pids).
 *
 * `container.*` comes from hand-parsed YAML (not Zod), so the values are
 * untrusted at runtime despite their static types — validate them here. In
 * particular `network` must be `bridge`/`none`: a stray `host` would otherwise
 * flow straight to `docker run --network host` and drop the network isolation.
 */
export function resolveContainerBackendConfig(
  cfg: { image?: string; network?: string; memoryMb?: number; pidsLimit?: number } | undefined
): ContainerBackendConfig {
  const network = cfg?.network;
  if (network !== undefined && network !== 'bridge' && network !== 'none') {
    throw new Error(
      `Invalid container.network '${network}' in .archon/config.yaml — must be ` +
        "'bridge' or 'none'. Host networking is not allowed for container isolation."
    );
  }
  // Positive INTEGERS — `docker run --memory`/`--pids-limit` reject fractions,
  // and Number.isFinite alone would let `512.5` through to a runtime docker error.
  const memoryMb = cfg?.memoryMb;
  if (memoryMb !== undefined && (!Number.isInteger(memoryMb) || memoryMb <= 0)) {
    throw new Error(
      `Invalid container.memoryMb '${String(memoryMb)}' — must be a positive integer (MiB).`
    );
  }
  const pidsLimit = cfg?.pidsLimit;
  if (pidsLimit !== undefined && (!Number.isInteger(pidsLimit) || pidsLimit <= 0)) {
    throw new Error(
      `Invalid container.pidsLimit '${String(pidsLimit)}' — must be a positive integer.`
    );
  }
  return {
    image: cfg?.image?.trim() || DEFAULT_RUNNER_IMAGE,
    network: network ?? 'bridge',
    memoryMb: memoryMb ?? 4096,
    pidsLimit: pidsLimit ?? 512,
  };
}

/**
 * H2 — a container run has an UNRESOLVED write-back when its overlay diff was raised
 * for review (`pending_writeback` set) but never applied or discarded
 * (`writeback_resolved !== true`). This happens on a failed/partial apply. The CLI
 * teardown must PRESERVE the container+volume in this state (the overlay is the only
 * copy of the changes) rather than destroy it. Pure so the decision is unit-testable.
 */
export function hasUnresolvedWriteback(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return metadata.pending_writeback !== undefined && metadata.writeback_resolved !== true;
}

/**
 * Wraps a codebase auto-registration failure. Preserves the original error message;
 * a refusal already says what to do, other failures get a workspace-root pointer.
 */
function buildRegistrationFailureError(error: Error): Error {
  let hint = '';
  if (!(error instanceof ProjectRegistrationError)) {
    // Guard against a throwing getArchonHome() (misconfigured env vars, etc.):
    // the registration error we're wrapping is the load-bearing one — we'd
    // rather lose the exact path in the hint than replace it with a secondary
    // home-resolution error that masks the root cause.
    try {
      const workspacesPath = join(getArchonHome(), 'workspaces');
      hint = `\nHint: Check your Archon workspace registration under ${workspacesPath} and retry.`;
    } catch {
      hint = '\nHint: Check your Archon workspace registration and retry.';
    }
  }

  return new Error(
    `Cannot run workflow: project registration failed.\nError: ${error.message}${hint}`
  );
}

/** Error for --branch/--from/--base used against a folder project (no worktree). */
function folderWorktreeOptionError(): Error {
  return new Error(
    'Worktree options require a git-repo project.\n' +
      '  --branch/--from/--base act on an isolated git worktree, which folder projects do not use.\n' +
      '  Drop --branch/--from/--base — folder projects always run in place.'
  );
}

/**
 * Warn that `--base` is only HALF applied when an existing worktree is adopted
 * (`--branch` reuse or `--resume`): its cut-from is already fixed, but the
 * override still reaches `$BASE_BRANCH` and retargets the PR.
 *
 * Deliberately not `--from`'s "was not applied" wording — that is accurate for
 * `--from`, which is wholly inert on reuse, and would understate this case.
 */
export function warnBaseOverrideOnReuse(workingPath: string, flagBase: string): void {
  getLog().warn(
    { path: workingPath, baseBranch: flagBase },
    'worktree.reuse_base_override_partial'
  );
  console.warn(
    `Warning: Reusing existing worktree at ${workingPath}. ` +
      `--base ${flagBase} did not change the cut-from (worktree already exists); ` +
      'it still applies to the PR target.'
  );
}

/** Error for a worktree-pinned workflow run against a folder project. */
function folderWorktreePolicyError(workflowName: string): Error {
  return new Error(
    `Workflow '${workflowName}' requires a worktree (worktree.enabled: true), ` +
      'which is not available for folder projects (no Archon-managed worktree).\n' +
      '  Run this workflow against a git-repo project, or change its worktree policy.'
  );
}

/**
 * Error for a failed `--folder` project registration. Distinct from
 * {@link buildRegistrationFailureError} because a folder project has no workspace
 * `source` link, so its workspace hints would be misleading here.
 */
function buildFolderRegistrationFailureError(error: Error): Error {
  return new Error(
    'Cannot register folder project.\n' +
      `Error: ${error.message}\n` +
      'Hint: Check that the directory is readable and your Archon home ' +
      '(~/.archon) is writable, then retry.'
  );
}

/**
 * Refuse an isolated run that has no project to isolate, naming which step failed.
 *
 * One owner because two callers enforce the same policy at different times: the
 * `--detach` pre-flight, which must refuse before the fork (#2872), and the isolation
 * block, which is where a foreground run reaches it. Two copies of this decision is
 * exactly how the detached path came to skip it.
 *
 * A no-op once a codebase resolved — the isolation block only reaches it with none, and
 * the pre-flight calls it unconditionally for an isolating run.
 */
export function assertCodebaseResolvedForIsolation(resolved: { codebase: Codebase | null }): void {
  if (resolved.codebase) return;
  throw new Error(
    'Cannot create worktree: not in a git repository.\n' +
      'Run from within a git repo, or use --no-worktree to skip isolation.'
  );
}

/**
 * Fail fast if `--branch`/`--from`/`--base` (git-worktree-only options) are used
 * against a folder project. Called at three sites — flag-declared (pre-detach), the
 * detach fast-path, and post-lookup (authoritative) — so the check lives in one place.
 *
 * `--base` belongs here even though a folder run creates no worktree for it to
 * redirect: it would still reach `$BASE_BRANCH`, giving the run a PR target with
 * no worktree behind it.
 */
export function assertNoWorktreeOptionsForFolder(
  isFolderProject: boolean,
  options: WorkflowRunOptions
): void {
  if (
    isFolderProject &&
    (options.branchName !== undefined ||
      options.fromBranch !== undefined ||
      options.baseBranch !== undefined)
  ) {
    throw folderWorktreeOptionError();
  }
}

/** Fail fast if a `worktree.enabled: true` workflow is run against a folder project. */
export function assertWorkflowNotWorktreePinnedForFolder(
  isFolderProject: boolean,
  pinnedEnabled: boolean | undefined,
  workflowName: string
): void {
  if (isFolderProject && pinnedEnabled === true) {
    throw folderWorktreePolicyError(workflowName);
  }
}

/**
 * Resolve the project this run belongs to: look it up, else register it.
 *
 * Registered folders own descendants unless a nested repository starts inside
 * them. Repository checkouts resolve through Git identity.
 *
 * One implementation because two callers need the same answer: the `--detach`
 * pre-flight, which must resolve the project before it can create the run row or
 * refuse an adoption (#2872), and the run path itself. Registration is idempotent,
 * so the detached child's own call finds what the parent registered.
 *
 * Explicit folder selection fails on unknown or conflicting registration. Any lookup
 * or registration failure is fatal. First-time folder registration is returned too,
 * because detached JSON output cannot include a prose notice.
 */
export async function resolveRunCodebase(
  host: WorkflowHost,
  cwd: string,
  options: Pick<WorkflowRunOptions, 'codebaseId' | 'folder' | 'registrationBaseBranch'>
): Promise<{
  codebase: Codebase | null;
  /** Set only when THIS call registered a new folder project. */
  registeredFolder?: { name: string; defaultCwd: string };
}> {
  let codebase: Codebase | null = null;
  let registeredFolder: { name: string; defaultCwd: string } | undefined;
  cwd = await canonicalizeProjectPath(cwd);
  let repoRoot: string | null = null;
  try {
    if (options.codebaseId) {
      codebase = await host.records.codebases.getCodebase(options.codebaseId);
    } else if (options.folder) {
      codebase = await host.records.codebases.findCodebaseByDefaultCwd(cwd);
    } else {
      ({ codebase, repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases));
    }
  } catch (error) {
    if (error instanceof InvalidCodebaseDefaultCwdError) throw error;
    const err = error as Error;
    getLog().warn({ err, cwd }, 'cli.codebase_lookup_failed');
    if (
      err.message.includes('connect') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ETIMEDOUT')
    ) {
      getLog().warn(
        { hint: 'Check DATABASE_URL and that the database is running.' },
        'cli.db_connection_hint'
      );
    }
    throw new Error(`Cannot run workflow: project lookup failed.\nError: ${err.message}`, {
      cause: err,
    });
  }
  if (options.codebaseId && !codebase)
    throw new Error(`Project "${options.codebaseId}" no longer exists.`);

  if (options.registrationBaseBranch !== undefined) {
    if (options.folder || (!repoRoot && !codebase) || codebase?.kind === 'folder')
      throw new Error('Folder projects have no base branch; remove --base-branch.');
    if (codebase)
      throw new Error(
        '--base-branch applies only to initial registration. This project is already registered; use --base for a run override.'
      );
  }

  if (options.folder) {
    if (codebase && codebase.kind !== 'folder') {
      throw new Error(
        `Project "${codebase.name}" is already registered as a repo; cannot register it as a folder project.`
      );
    }
  }

  if (!codebase && (options.folder || repoRoot)) {
    try {
      const result = options.folder
        ? await registerFolder(host.records.codebases, cwd)
        : await registerRepository(host.records.codebases, repoRoot ?? cwd, {
            baseBranch: options.registrationBaseBranch,
          });
      codebase = await host.records.codebases.getCodebase(result.codebaseId);
      if (!codebase)
        throw new Error(`Registered project "${result.codebaseId}" could not be read back.`);
      if (!result.alreadyExisted) {
        if (options.folder) registeredFolder = { name: result.name, defaultCwd: result.defaultCwd };
        getLog().info({ name: result.name }, 'cli.codebase_auto_registered');
      }
    } catch (error) {
      if (error instanceof InvalidCodebaseDefaultCwdError) throw error;
      const err = error as Error;
      if (options.registrationBaseBranch !== undefined) throw err;
      // Running unregistered would file the run under `_cwd/<folder name>`, storage
      // and state that every checkout with the same folder name shares (#1192).
      throw options.folder
        ? buildFolderRegistrationFailureError(err)
        : buildRegistrationFailureError(err);
    }
  }

  return { codebase, registeredFolder };
}

/**
 * A resume continues in the run's own checkout. Cleanup removes a failed run's
 * worktree once its outcome is settled or stale (#4090), and nothing can recreate it.
 */
export function assertResumeWorkingPathExists(workingPath: string): void {
  try {
    statSync(workingPath);
  } catch (error) {
    // Only absence means cleanup removed it; a permission error or symlink loop is the operator's to fix.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    throw new Error(
      `Cannot resume: the working path from the run no longer exists: ${workingPath}\n` +
        'The worktree may have been cleaned up. Start a fresh run with --branch instead.'
    );
  }
}
