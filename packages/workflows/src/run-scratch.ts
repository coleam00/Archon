/**
 * Release scratch: a node invocation's own when it ends, and a terminal run's whole
 * scratch and tagged artifact caches when the run ends.
 *
 * `releaseNodeScratch` removes one invocation's `$NODE_SCRATCH_DIR` once that invocation
 * has completed, failed or been skipped; the layer walker calls it, so the invocation's
 * own processes have ended, and also when a resumed run skips or replays an invocation
 * that a prior pass left suspended. Run-end release below
 * stays the backstop for an invocation that never got there (interrupted, or its
 * process died).
 *
 * Scratch is removed only once the run is terminal and nothing of it can still write
 * into it. `releaseRunScratch` proves the second half itself: the run's recorded
 * execution owner must be this process, no longer executing the run, or a process on
 * this host that no longer exists. A run can be terminal while its executor still runs
 * nodes: a cooperative cancel, `halt` or a fan-out cancel commits while they write, a
 * gate pauses its run while sibling nodes in the same layer still execute, and a CLI
 * stopped by a signal records `failed` before it ends its node trees.
 * - The executor releases scratch when it exits and the run is terminal; its nodes have
 *   stopped by then. A host may defer deletion until it reports the settled outcome,
 *   then drain cleanup before sleeping or shutting down.
 * - Cancel, abandon, a conversation reset and a cancelling gate reject release the
 *   scratch of the runs they cancelled. Where the owner proof fails, scratch is kept: an
 *   owner on another host, a recorded owner process still alive, or an output holder a
 *   stop left running.
 * - A container run is skipped by all of these: its container mounts the artifacts
 *   directory and lives past the terminal write. The container backend calls
 *   `removeRunScratch` once the container is removed, so a gate reject that proves the
 *   owner gone reclaims the container.
 *
 * Scratch and descendant directories carrying a valid CACHEDIR.TAG are disposable;
 * untagged evidence and the artifacts root are retained. Git worktrees a node added
 * under scratch are removed from the run's repository first, so their registrations
 * do not outlive their files. At run end a container run's are not: they live in the
 * container's git, which container teardown removes with the container. A node's own
 * scratch in a live container is deregistered through that container's git.
 */

import { hostname } from 'node:os';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { execFileAsync, GitFailure } from '@archon/git';
import { createLogger } from '@archon/paths';
import { isPidProvablyGone } from '@archon/paths/process-owner';
import {
  getNodeScratchDir,
  getNodeScratchRoot,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  isPathInside,
  resolveRunStorageRoot,
} from '@archon/paths/archon-paths';
import type { ExecutionContext } from '@archon/provider-contract';
import { isContainerRun, readExecutionOwner, type WorkflowRun } from './schemas/workflow-run';
import { probeContainerMarker } from './checkout-observation';
import { buildSubprocessDockerArgs } from './subprocess';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-scratch');
  return cachedLog;
}

type ScratchRun = Pick<WorkflowRun, 'id' | 'output_root' | 'working_path' | 'metadata'>;

/** Executions of each run in progress in this process; a run can re-enter itself. */
const executingHere = new Map<string, number>();

/**
 * Count `runId` as executing in this process until the returned function is called. The
 * executor holds it while the run's nodes can run, so a release in the same process can
 * tell an executor that is still running from one that has exited.
 */
export function enterRunExecution(runId: string): () => void {
  executingHere.set(runId, (executingHere.get(runId) ?? 0) + 1);
  return () => {
    const count = (executingHere.get(runId) ?? 1) - 1;
    if (count > 0) executingHere.set(runId, count);
    else executingHere.delete(runId);
  };
}

/**
 * True only when no executor of `run` can still be running: its recorded execution owner
 * is this process and it is not executing the run, or a process on this host that no
 * longer exists. Every executor stamps the runs it executes, a sub-run or a parent
 * resumed in its child's process included, so the record names the process that last
 * ran the run's nodes. A reused pid reads as alive and keeps scratch.
 */
export function noExecutorCanWrite(run: Pick<WorkflowRun, 'id' | 'metadata'>): boolean {
  const owner = readExecutionOwner(run.metadata);
  if (owner?.host !== hostname()) return false;
  if (owner.pid === process.pid) return !executingHere.has(run.id);
  return isPidProvablyGone(owner.pid);
}

/**
 * Remove a terminal run's scratch once no executor can still write it. The caller
 * guarantees the run is terminal and that nothing it left running outside the executor,
 * such as an output holder a stop could not end, still writes. Never throws: the status
 * write is authoritative, and a failed removal is only logged.
 */
export async function releaseRunScratch(run: ScratchRun): Promise<void> {
  if (isContainerRun(run)) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.left_to_container_teardown');
    return;
  }
  if (!noExecutorCanWrite(run)) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.kept_for_live_owner');
    return;
  }
  // A row with no trusted output_root (created before the column existed, or on the
  // identity_unresolved path) has no locatable artifacts directory, so nothing is removed.
  const root = resolveRunStorageRoot(run, null);
  if (!root) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.no_storage_root');
    return;
  }
  const artifactsDir = getRunArtifactsDirForRoot(root, run.id);
  const logContext = { workflowRunId: run.id };
  // Git removes worktree files too, so capture tags and allocation before deregistration.
  const caches = await discoverTaggedCaches(artifactsDir, logContext);
  if (
    run.working_path !== null &&
    (await scratchParentIsDirectory(artifactsDir, logContext)) &&
    (await isDirectory(getRunScratchDir(artifactsDir), logContext))
  ) {
    await deregisterScratchWorktrees(
      hostGit(run.working_path),
      getRunScratchDir(artifactsDir),
      logContext
    );
  }
  await removeScratchAndCaches(artifactsDir, logContext, caches);
}

/**
 * Remove one node invocation's scratch directory, deregistering the git worktrees under
 * it from `repoPath` first. In a container run the node registered them in the
 * container's git, at the same absolute paths, so they are deregistered there. Never
 * throws: a failed release is logged and the node's result stands; run-end release
 * retries the removal.
 *
 * Nothing is touched unless every directory from `artifactsDir` down to the node-scratch
 * root is a real directory: through a linked ancestor, the path would name files and
 * worktrees outside the run. A link in place of the invocation's own directory is removed
 * without following it.
 */
export async function releaseNodeScratch({
  artifactsDir,
  invocationId,
  repoPath,
  execContext,
  logContext,
}: {
  artifactsDir: string;
  invocationId: string;
  repoPath: string;
  execContext: ExecutionContext;
  logContext: Record<string, unknown>;
}): Promise<void> {
  const scratchDir = getNodeScratchDir(artifactsDir, invocationId);
  try {
    const stat = await lstat(scratchDir);
    if (!(await nodeScratchRootIsDirectory(artifactsDir, logContext))) {
      getLog().warn({ ...logContext, path: scratchDir }, 'node_scratch.ancestor_not_directory');
      return;
    }
    // An empty directory, the common case, costs no git subprocess.
    if (stat.isDirectory() && (await readdir(scratchDir)).length > 0) {
      const git =
        execContext.kind === 'container'
          ? await containerGit(execContext, repoPath, logContext)
          : hostGit(repoPath);
      if (git) await deregisterScratchWorktrees(git, scratchDir, logContext);
    }
    await rm(scratchDir, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    getLog().warn({ ...logContext, err: error, path: scratchDir }, 'node_scratch.remove_failed');
  }
}

/**
 * Whether `artifactsDir`, its engine child, the run's scratch and the node-scratch root
 * are all real directories, links rejected. Creation checks it too, so a node is never
 * handed a directory outside the run.
 */
export async function nodeScratchRootIsDirectory(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<boolean> {
  return (
    (await scratchParentIsDirectory(artifactsDir, logContext)) &&
    (await isDirectory(getRunScratchDir(artifactsDir), logContext)) &&
    (await isDirectory(getNodeScratchRoot(artifactsDir), logContext))
  );
}

/**
/** Runs `git` against one repository, on the host or in the run's container. */
type RepoGit = (args: string[], timeout: number) => Promise<{ stdout: string }>;

function hostGit(repoPath: string): RepoGit {
  return (args, timeout) => execFileAsync('git', ['-C', repoPath, ...args], { timeout });
}

/**
 * Git in the run's container, or undefined when the container's checkout is not a
 * repository (a folder project), which has no worktrees to deregister. The container's
 * own failures are not that answer: they are logged and nothing is deregistered.
 */
async function containerGit(
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  repoPath: string,
  logContext: Record<string, unknown>
): Promise<RepoGit | undefined> {
  const marker = await probeContainerMarker(repoPath, execContext);
  if (marker === 'none') return undefined;
  if (marker === 'failed') {
    getLog().warn({ ...logContext, path: repoPath }, 'run_scratch.container_probe_failed');
    return undefined;
  }
  return (args, timeout) =>
    execFileAsync(
      'docker',
      buildSubprocessDockerArgs(execContext, 'git', ['-C', repoPath, ...args], {
        cwd: repoPath,
        env: {},
      }),
      { timeout }
    );
}

/**
 * Remove the git worktrees a node added under `scratchDir` from the repository of the
 * run's checkout, so deleting their files leaves no registration behind in it. Only
 * worktrees whose resolved path is `scratchDir` or inside it are touched: never the run's
 * checkout or any other worktree. Each is removed by path; `git worktree prune` is never
 * run, because it would also drop unrelated registrations whose checkouts are missing. A
 * worktree of another repository is not found here; its files are still deleted with the
 * rest of scratch.
 */
async function deregisterScratchWorktrees(
  git: RepoGit,
  scratchDir: string,
  logContext: Record<string, unknown>
): Promise<void> {
  // A failure below is logged and the caller still deletes the files. That is safe: a
  // registration whose checkout is gone holds no work, Git reports it as prunable, and
  // `git worktree prune` drops it. Keeping scratch instead would keep the run's bulk on
  // disk for a leftover that costs nothing.
  const warn = (path: string, error: unknown): void => {
    getLog().warn({ ...logContext, err: error, path }, 'run_scratch.worktree_deregister_failed');
  };
  try {
    // Git prints resolved paths, so the scratch directory is resolved to compare. A
    // container mounts it at the path as given, so that form is matched too.
    const roots = [scratchDir, await realpath(scratchDir)];
    const { stdout } = await git(['worktree', 'list', '--porcelain', '-z'], 10000);
    for (const field of stdout.split('\0')) {
      if (!field.startsWith('worktree ')) continue;
      const path = field.slice('worktree '.length);
      if (!roots.some(root => isPathInside(root, path, { includeRoot: true }))) continue;
      // `--force`: a scratch worktree is throwaway, and uncommitted changes must not keep it.
      await git(['worktree', 'remove', '--force', path], 30000).catch((error: unknown) => {
        warn(path, error);
      });
    }
  } catch (error) {
    // A run outside a git repository has no worktrees to deregister.
    if (error instanceof GitFailure && error.kind === 'not_repository') return;
    warn(scratchDir, error);
  }
}

/**
 * Remove `artifactsDir`'s scratch child and validly tagged descendant caches. The caller
 * guarantees the run is terminal and nothing of it can still write into `artifactsDir`.
 * Never throws; failures are logged with `logContext`.
 *
 * A recursive `rm` does not follow symlinks inside the tree, so a link a node left in
 * scratch is removed, not its target.
 */
export async function removeRunScratch(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<void> {
  const caches = await discoverTaggedCaches(artifactsDir, logContext);
  await removeScratchAndCaches(artifactsDir, logContext, caches);
}

type TaggedCache = { path: string; estimatedFreedBytes: number | null };

async function removeScratchAndCaches(
  artifactsDir: string,
  logContext: Record<string, unknown>,
  caches: TaggedCache[]
): Promise<void> {
  for (const cache of caches) await removeCache(cache, artifactsDir, logContext);
  if (!(await scratchParentIsDirectory(artifactsDir, logContext))) return;
  const scratchDir = getRunScratchDir(artifactsDir);
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch (error) {
    getLog().warn({ ...logContext, err: error, path: scratchDir }, 'run_scratch.remove_failed');
  }
}

const cacheSignature = Buffer.from('Signature: 8a477f597d28d172789f06886806bc55');

function warnFilesystem(error: unknown, path: string, logContext: Record<string, unknown>): void {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
  getLog().warn({ ...logContext, err: error, path }, 'run_scratch.inspect_failed');
}

async function isDirectory(path: string, logContext: Record<string, unknown>): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    warnFilesystem(error, path, logContext);
    return false;
  }
}

// Writer ordering excludes our own mutations. These checks reject existing links;
// they do not defend against a hostile outside process swapping ancestors afterward.
async function scratchParentIsDirectory(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<boolean> {
  return (
    (await isDirectory(artifactsDir, logContext)) &&
    (await isDirectory(dirname(getRunScratchDir(artifactsDir)), logContext))
  );
}

async function hasCacheTag(path: string, logContext: Record<string, unknown>): Promise<boolean> {
  const tag = join(path, 'CACHEDIR.TAG');
  try {
    if (!(await lstat(tag)).isFile()) return false;
    const file = await open(tag, 'r');
    try {
      const prefix = Buffer.alloc(cacheSignature.length);
      const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
      return bytesRead === prefix.length && prefix.equals(cacheSignature);
    } finally {
      await file.close();
    }
  } catch (error) {
    warnFilesystem(error, tag, logContext);
    return false;
  }
}

async function estimateCacheBytes(path: string): Promise<number> {
  const pending = [path];
  const seen = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) break;
    const stat = await lstat(current);
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bytes += stat.blocks * 512;
    if (stat.isDirectory()) {
      for (const name of await readdir(current)) pending.push(join(current, name));
    }
  }
  return bytes;
}

async function measureCache(
  path: string,
  logContext: Record<string, unknown>
): Promise<TaggedCache> {
  try {
    return { path, estimatedFreedBytes: await estimateCacheBytes(path) };
  } catch (error) {
    getLog().warn({ ...logContext, err: error, path }, 'run_scratch.cache_measure_failed');
    return { path, estimatedFreedBytes: null };
  }
}

async function discoverTaggedCaches(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<TaggedCache[]> {
  const caches: TaggedCache[] = [];
  const pending = [artifactsDir];
  while (pending.length) {
    const path = pending.pop();
    if (path === undefined) break;
    if (!(await isDirectory(path, logContext))) continue;
    if (path !== artifactsDir && (await hasCacheTag(path, logContext))) {
      caches.push(await measureCache(path, logContext));
      continue;
    }
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(join(path, entry.name));
      }
    } catch (error) {
      warnFilesystem(error, path, logContext);
    }
  }
  return caches;
}

async function removeCache(
  { path, estimatedFreedBytes }: TaggedCache,
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    getLog().info(
      { ...logContext, artifactsDir, path: relative(artifactsDir, path), estimatedFreedBytes },
      'run_scratch.cache_removed'
    );
  } catch (error) {
    getLog().warn({ ...logContext, err: error, path }, 'run_scratch.cache_remove_failed');
  }
}
