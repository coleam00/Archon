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
import {
  classifyIsolationError,
  resolveFolderBackend,
  type ContainerBackend,
  type ContainerBackendConfig,
  type ExecutionContext,
  type IsolationEnvironmentRow,
  type PreparedEnv,
} from '@archon/isolation';
import * as git from '@archon/git';
import { mkdir } from 'node:fs/promises';
import { loadRepoConfig } from '@archon/core/config/config-loader';
import type { OverlayMode } from '@archon/workflows/container-context';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import { resolveProjectPaths } from '@archon/workflows/run-paths';
import {
  finalizeWorkflowSource,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
} from '@archon/workflows/run-source';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
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

/** The folder-backend seam's result: where the run executes, and its container if any. */
export interface FolderExecution {
  workingCwd: string;
  execContext: ExecutionContext;
  /** The capture after any finalization, which moves it to the run's final path. */
  preparedSource: PreparedWorkflowSource | undefined;
  /** Held so the CLI tears the container down after a TERMINAL run. */
  container?: {
    backend: ContainerBackend;
    envId: string | undefined;
    overlayMode: OverlayMode | undefined;
  };
}

interface FolderCodebase {
  id: string;
  defaultCwd: string;
  name: string;
  kind: 'folder';
}

/**
 * Whether a folder project's run executes in a container rather than in place.
 * Precedence: --container flag > workflow `container.enabled` > config
 * `container.enabled` (default off). A resume honors the original run's stamped
 * isolation, never the current flag or config, so it cannot switch a container run
 * to in-place on the live root.
 */
export function folderRunsInContainer(
  options: Pick<WorkflowRunOptions, 'container' | 'resume'>,
  workflow: Pick<ResolvedWorkflow, 'container'>,
  folderConfig:
    | Pick<Awaited<ReturnType<WorkflowHost['deps']['loadConfig']>>, 'container'>
    | undefined,
  resumable: Pick<WorkflowRun, 'metadata'> | null | undefined
): boolean {
  return options.resume
    ? resumable?.metadata?.isolation === 'container'
    : (options.container ??
        workflow.container?.enabled ??
        folderConfig?.container?.enabled ??
        false);
}

/**
 * Prepare a folder project's execution. Folder projects run through the folder-backend
 * seam — no worktree isolation. The in-place backend (default) keeps the agent's cwd at
 * the folder root, so it sees every child folder/repo, and per-service git
 * (branch/commit/PR) is the agent's job via bash/gh. The container backend (--container /
 * config) instead runs everything inside an overlay-isolated container.
 */
export async function prepareFolderExecution(input: {
  host: WorkflowHost;
  codebase: Codebase;
  options: WorkflowRunOptions;
  workflow: ResolvedWorkflow;
  resumable: WorkflowRun | null;
  preparedSource: PreparedWorkflowSource | undefined;
  owner: CapturedSourceOwner;
  workingCwd: string;
}): Promise<FolderExecution> {
  const { host, codebase, options, workflow, resumable, owner } = input;
  const folderCodebase: FolderCodebase = {
    id: codebase.id,
    defaultCwd: codebase.default_cwd,
    name: codebase.name,
    kind: 'folder' as const,
  };

  // Do NOT swallow loadConfig errors: a malformed/unreadable config that would carry
  // `container.*` policy must FAIL the run, never silently downgrade to an in-place
  // host run. loadConfig returns defaults when no config file exists (not an error).
  const folderConfig = await host.deps.loadConfig(codebase.default_cwd);

  if (folderRunsInContainer(options, workflow, folderConfig, resumable)) {
    const containerConfig = resolveContainerBackendConfig(folderConfig?.container);
    const backend = resolveFolderBackend(folderCodebase, {
      container: true,
      store: host.records.isolation,
      containerConfig,
    });
    let preparedSource = input.preparedSource;
    let prepared: PreparedEnv;
    if (options.resume) {
      prepared = await resumeFolderContainer(backend, resumable, containerConfig.image);
    } else {
      console.log(`Folder project — running in container (image ${containerConfig.image}).`);
      getLog().info(
        { cwd: codebase.default_cwd, image: containerConfig.image },
        'workflow.running_in_container'
      );
      try {
        // The container fixes its mounts at creation, so the run's source must already
        // be at its final path. Move it there now; executeWorkflow recomputes the same
        // destination and skips its own move.
        if (preparedSource) {
          preparedSource = await finalizeWorkflowSource(host.deps, preparedSource, {
            cwd: folderCodebase.defaultCwd,
            codebaseId: folderCodebase.id,
          });
          // Finalization moved the capture, so keep ownership on the path that now
          // exists. If container preparation fails below, the wrap reclaims the
          // finalized capture instead of the already-renamed staging path.
          owner.hold(preparedSource);
        }
        prepared = await backend.prepare({
          codebase: folderCodebase,
          ...((await containerMounts(host, folderCodebase, preparedSource)) ?? {}),
        });
      } catch (prepErr) {
        // Map docker/daemon/image failures to an actionable message (daemon
        // unreachable, runner image missing — see errors.ts).
        const err = prepErr as Error;
        getLog().error({ err, codebaseId: codebase.id }, 'workflow.container_prepare_failed');
        throw new Error(classifyIsolationError(err));
      }
    }
    // The container mounts the overlay at the SAME absolute path (same-absolute-
    // path invariant), so prepared.cwd is the folder root. Consume it explicitly
    // rather than assuming workingCwd — the container backend returns a
    // container-side cwd, unlike in-place.
    return {
      workingCwd: prepared.cwd,
      execContext: prepared.execContext,
      preparedSource,
      container: { backend, envId: prepared.envId, overlayMode: prepared.overlayMode },
    };
  }
  // In-place (default) — byte-identical to pre-container behavior: keep
  // workingCwd, only annotate the host execContext.
  console.log('Folder project — running in place (no worktree isolation).');
  getLog().info({ cwd: input.workingCwd }, 'workflow.running_without_isolation');
  const backend = resolveFolderBackend(folderCodebase, { container: false });
  const prepared = await backend.prepare({ codebase: folderCodebase });
  return {
    workingCwd: input.workingCwd,
    execContext: prepared.execContext,
    preparedSource: input.preparedSource,
  };
}

/**
 * Rediscover + restart the container for this run: `docker start` a
 * suspended container, or recreate one over the persisted upper volume
 * (the accumulated overlay is preserved). The env id was stamped into the
 * run metadata at first-run creation. resumeEnv fails LOUD if the volume
 * is gone (un-applied work lost) rather than restarting from empty.
 *
 * Ordering (L3): the container is restarted FIRST (here) even on a
 * write-back-only resume where no DAG node will re-execute — kept uniform
 * with the mid-DAG-approval resume, which DOES need a live container. The
 * subsequent write-back apply runs in an INDEPENDENT `docker run` helper
 * over the volume (see overlay.ts), so it neither needs nor races the
 * restarted run container.
 */
async function resumeFolderContainer(
  backend: ContainerBackend,
  resumable: WorkflowRun | null,
  image: string
): Promise<PreparedEnv> {
  const resumeEnvId =
    typeof resumable?.metadata?.isolation_env_id === 'string'
      ? resumable.metadata.isolation_env_id
      : undefined;
  if (!resumeEnvId) {
    throw new Error(
      `Cannot resume container run '${resumable?.id ?? '?'}': its isolation env id is ` +
        'missing from the run metadata. Start a fresh --container run instead.'
    );
  }
  console.log(`Folder project — resuming container run (image ${image}).`);
  getLog().info({ envId: resumeEnvId, image }, 'workflow.resuming_in_container');
  try {
    return await backend.resumeEnv(resumeEnvId);
  } catch (resumeErr) {
    const err = resumeErr as Error;
    getLog().error({ err, envId: resumeEnvId }, 'workflow.container_resume_failed');
    throw new Error(classifyIsolationError(err));
  }
}

/**
 * `$ARTIFACTS_DIR` is the run's output channel on both sides of the boundary,
 * so it is bound read-write at the same absolute path. Created here by the host
 * user: a bind target Docker has to create itself would be owned by root.
 */
async function containerMounts(
  host: WorkflowHost,
  folderCodebase: FolderCodebase,
  preparedSource: PreparedWorkflowSource | undefined
): Promise<{ sourceMount: string; artifactsMount: string } | undefined> {
  if (!preparedSource) return undefined;
  const { artifactsDir } = await resolveProjectPaths(
    host.deps,
    folderCodebase.defaultCwd,
    preparedSource.runId,
    folderCodebase.id
  );
  await mkdir(artifactsDir, { recursive: true });
  // Read-only source and read-write artifacts, both at the same absolute path
  // inside the container, so a path means one thing on either side of the
  // boundary.
  return { sourceMount: preparedSource.anchor.root, artifactsMount: artifactsDir };
}

/**
 * Warn about what an explicit `--branch` reuse of a healthy worktree does not apply:
 * `--from`, a `--base` cut-from, and a base the worktree was not cut from.
 */
export async function warnOnReusedWorktree(
  existingEnv: IsolationEnvironmentRow,
  codebase: Codebase,
  options: WorkflowRunOptions,
  flagBase: string | undefined,
  codebaseDefaultBranch: string | undefined
): Promise<void> {
  if (options.fromBranch) {
    getLog().warn(
      { path: existingEnv.working_path, fromBranch: options.fromBranch },
      'worktree.reuse_from_branch_ignored'
    );
    console.warn(
      `Warning: Reusing existing worktree at ${existingEnv.working_path}. ` +
        `--from ${options.fromBranch} was not applied (worktree already exists).`
    );
  }
  if (flagBase) {
    warnBaseOverrideOnReuse(existingEnv.working_path, flagBase);
  }
  // Validate base branch before reuse (warning-only — non-blocking)
  try {
    const repoConfig = await loadRepoConfig(codebase.default_cwd);
    const rawBase = repoConfig?.worktree?.baseBranch?.trim();
    const repoPath = git.toRepoPath(codebase.default_cwd);
    const remote = repoConfig?.worktree?.remote?.trim() || (await git.getDefaultRemote(repoPath));
    if (!remote) throw new Error('Set worktree.remote to select a git remote.');
    // Four-level fallback: --base override → repo config → codebase default →
    // git auto-detect. Mirrors WorktreeProvider and executeWorkflow, so the
    // reuse check validates against the base this dispatch actually asked
    // for instead of reporting a mismatch nobody requested.
    let configuredBase: git.BranchName;
    if (flagBase) {
      configuredBase = git.toBranchName(flagBase);
    } else if (rawBase) {
      configuredBase = git.toBranchName(rawBase);
    } else if (codebaseDefaultBranch) {
      configuredBase = git.toBranchName(codebaseDefaultBranch);
    } else {
      configuredBase = await git.getDefaultBranch(repoPath, remote);
    }
    const isValidBase = await git.isAncestorOf(
      git.toWorktreePath(existingEnv.working_path),
      `${remote}/${configuredBase}`
    );
    if (!isValidBase) {
      getLog().warn(
        { path: existingEnv.working_path, configuredBase, branch: existingEnv.branch_name },
        'worktree.reuse_base_branch_mismatch'
      );
      console.warn(
        `Warning: Worktree '${existingEnv.branch_name}' is not based on '${configuredBase}'. ` +
          `Recreate with: bun run cli complete ${existingEnv.branch_name} --force`
      );
    }
  } catch (e) {
    getLog().debug({ err: e }, 'worktree.reuse_base_branch_check_skipped');
    // Non-blocking — skip warning if base branch cannot be determined
  }
}

type RunStore = WorkflowHost['deps']['store'];

/**
 * Whether a settled run's write-back is still un-applied. FAIL CLOSED (R2-F1): if the
 * run's metadata cannot be read, whether an un-applied write-back is pending is unknown
 * — answer true so the volume, which may be the only copy of the changes, is kept and
 * surfaced like an unresolved write-back.
 */
export async function readUnresolvedWriteback(
  store: RunStore,
  runId: string,
  envId: string
): Promise<boolean> {
  try {
    const finalRun = await store.getWorkflowRun(runId);
    return hasUnresolvedWriteback(finalRun?.metadata);
  } catch (lookupErr) {
    getLog().error(
      { err: lookupErr as Error, envId, runId },
      'workflow.teardown_run_lookup_failed'
    );
    return true;
  }
}

export function warnPreservedContainer(envId: string, runId: string | undefined): void {
  console.error(
    '\nWARNING: the write-back did not complete — the container + overlay volume are ' +
      'PRESERVED so your changes are not lost. Retry with ' +
      `\`bun run cli workflow resume ${runId ?? '<run-id>'}\` (re-applies the ` +
      'overlay), or reclaim manually via `docker ps -a --filter label=diy.archon.managed=true`.'
  );
  getLog().warn({ envId, runId }, 'workflow.container_preserved_unresolved_writeback');
}

/**
 * Destroy a settled run's container and record it. Returns the error of a GENUINE docker
 * failure (destroy is idempotent on not-found), already surfaced loudly, so the caller
 * can fail an otherwise-successful run instead of reporting success with a leaked
 * privileged container.
 */
export async function destroyRunContainer(
  store: RunStore,
  backend: ContainerBackend,
  envId: string,
  runId: string | undefined
): Promise<Error | undefined> {
  try {
    await backend.destroy(envId);
    // Persist a container_destroyed event (console timeline) and emit for any
    // live subscriber. The row commits after this process closed its progress
    // subscription, so it is not rendered here. No runId on the pre-result throw
    // path — skip the event, still destroy.
    if (runId) {
      getWorkflowEventEmitter().emit({
        type: 'container_lifecycle',
        runId,
        phase: 'destroyed',
      });
      await store
        .createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'container_destroyed',
          step_name: 'container',
          data: {},
        })
        .catch((eventErr: Error) => {
          getLog().warn(
            { err: eventErr, runId },
            'workflow.container_destroyed_event_persist_failed'
          );
        });
    }
    console.log('Container and overlay volume removed.');
    return undefined;
  } catch (destroyErr) {
    // Surface it LOUD (console.error, not a --quiet log) so the operator cleans up
    // the privileged container manually.
    console.error(
      `\nWARNING: failed to remove the isolation container/volume: ${
        (destroyErr as Error).message
      }\n` +
        'Remove it manually: docker ps -a --filter label=diy.archon.managed=true ' +
        '(then `docker rm -f <name>` and `docker volume rm <name>-upper`).'
    );
    getLog().error({ err: destroyErr as Error, envId }, 'workflow.container_destroy_failed');
    return destroyErr as Error;
  }
}
