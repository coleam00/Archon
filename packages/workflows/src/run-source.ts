import { readWorkflowLifecycle } from './workflow-status-read';
import * as archonPaths from '@archon/paths';
import { createLogger } from '@archon/paths';
import { randomUUID } from 'crypto';
import { mkdir, readdir, rename, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { sourceReleaseNotice } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import { type RunPhase } from './executor-shared';
import { resolveAdoptedRunDir, resolveProjectPaths } from './run-paths';
import {
  WORKFLOW_SOURCE_METADATA_KEY,
  readWorkflowSourceState,
  type ResolvedWorkflow,
  type WorkflowLoadError,
  type WorkflowRun,
  type WorkflowSourceMetadata,
  type WorkflowWithSource,
} from './schemas';
import { isContainerRun } from './schemas/workflow-run';
import { CONTINUATION_RETRY_MS, executionClaim } from './store';
import { requireTerminalStatusWrite } from './terminal-status-write';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import {
  WorkflowSourceIntegrityError,
  WorkflowSourceUnavailableError,
  captureWorkflowSource,
  capturedSourceRoots,
  isSourceReadFailure,
  resolveRunSourceCapture,
  workflowSourceConfigFrom,
  type InstalledPacksRoot,
  type WorkflowSourceAnchor,
  type WorkflowSourceCapture,
  type WorkflowSourceConfig,
  type WorkflowSourceManifest,
  type WorkflowSourceRoots,
} from './workflow-source';

// Re-exported so callers driving the capture-first sequence need only this module.

export {
  WorkflowSourceIntegrityError,
  WorkflowSourceUnavailableError,
  capturedSourceRoots,
  loadWorkflowSource,
  recordSelectedWorkflow,
  resolveRunSourceCapture,
  workflowSourceConfigFrom,
} from './workflow-source';
export type { WorkflowSourceRoots } from './workflow-source';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * A capture taken BEFORE its workflow was selected, with the run id it is filed under.
 *
 * The reserved id is what makes the ordering possible: the capture has to live at the
 * run's own source path so a container can bind it and cleanup can reclaim it, but it
 * has to exist before discovery — and therefore before the run row. Reserving the id up
 * front is cheaper than inventing a second staging lifecycle for the gap.
 *
 * When the row already exists (a `--detach` child executing the row its parent created),
 * the caller supplies that id instead and the same invariant holds from the other side.
 */
export interface PreparedWorkflowSource {
  /** Reserved run id; the caller passes it back so the row and the capture agree. */
  runId: string;
  origin: string;
  manifest: WorkflowSourceManifest;
  anchor: WorkflowSourceAnchor;
  /** Roots to discover from — pass to `discoverWorkflowsWithConfig`. */
  roots: WorkflowSourceRoots;
}

/**
 * How long an unadopted staging directory survives before it is reclaimed.
 *
 * Generous on purpose: it must comfortably exceed the gap between capturing and adopting,
 * which spans discovery, isolation, and — for `--detach` — a child process starting. Not a
 * timeout on anything; adoption MOVES the capture out of staging, so anything still here
 * after this long belongs to no run.
 */
const STAGED_SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Reclaim staging directories no run ever adopted.
 *
 * The backstop behind {@link withCapturedSource}. That guard covers the paths it wraps;
 * this covers the ones nobody can enumerate — a process killed between capture and run, a
 * crash, a surface added later that forgets. Safe by construction, because adoption moves
 * the capture out of staging, and age-bounded so a concurrent invocation's in-flight
 * capture is never touched.
 *
 * Hygiene only: it never mutates a run and cannot affect one in progress.
 *
 * Throttled by TIME, not by process. Once-per-capture put a directory scan on the spawn
 * path of every fan-out child; once-per-*process* fixed that and broke the server, which
 * is one process for weeks — it swept on the first dispatch after boot and never again,
 * leaving crash debris to accumulate for the lifetime of the install. An interval is
 * correct for both: the CLI sweeps on its first capture, a server keeps sweeping, and no
 * dispatch pays more than one `readdir` an hour.
 */
const STAGED_SOURCE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastStagedSweepAt = 0;
async function sweepStaleStagedSources(): Promise<void> {
  const now = Date.now();
  if (now - lastStagedSweepAt < STAGED_SOURCE_SWEEP_INTERVAL_MS) return;
  lastStagedSweepAt = now;
  const stagingRoot = join(archonPaths.getArchonHome(), 'staged-source');
  try {
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    const cutoff = Date.now() - STAGED_SOURCE_TTL_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(stagingRoot, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true }).catch(() => {
        /* another process may be reclaiming the same entry — losing that race is fine */
      });
      getLog().debug({ path }, 'workflow.source_staging_reclaimed');
    }
  } catch {
    // No staging directory yet, or unreadable. Neither is worth failing a run over.
  }
}

/**
 * Own a prepared capture for the length of an operation: adopt it, or reclaim it.
 *
 * Preparation happens before a workflow is even selected, so the ways OUT are many — an
 * unknown name, a refused input contract, a flag conflict, a gate, an isolation error, a
 * detached dispatch that hands the work to a child. Asking each of those to remember a
 * disposal call is how a dozen of them came not to: a typo'd workflow name leaked a
 * complete frozen tree, unbounded, once per invocation.
 *
 * `adopt()` transfers ownership to a run. Anything else — a return, a throw, a branch
 * nobody has written yet — reclaims. That is the difference between a leak that is fixed
 * and one that cannot recur.
 *
 * ONE mechanism, deliberately. An earlier pass built this, described this exact leak in
 * this exact docblock, and then never called it: the CLI hand-rolled an equivalent, the
 * background dispatch used a manual `dispose` in one catch, and chat — the highest-traffic
 * surface — got neither and kept leaking on five returns. Three shapes for one invariant is
 * how the busiest path ends up with none.
 */
export interface CapturedSourceOwner {
  /**
   * Take responsibility for a capture. Call again if its path changes — a container run
   * finalizes early and moves the capture out of staging, and reclaiming the pre-move path
   * would leave the real one behind while looking like it cleaned up.
   */
  hold: (prepared: Pick<PreparedWorkflowSource, 'anchor'>) => void;
  /**
   * A run now owns the bytes and their lifetime; stop tracking them. Called by the
   * caller from `executeWorkflow`'s rename success site (via
   * `ExecuteWorkflowOptions.capturedSourceOwner`) once the staged capture has been moved
   * to the run's own source path. Earlier call sites — before the rename — could
   * leave the staged directory orphaned when the rename itself failed (#2690); adoption
   * at the rename site means a failed move leaves the wrap's `finally` to reclaim.
   */
  adopt: () => void;
}

export async function withCapturedSource<T>(
  body: (owner: CapturedSourceOwner) => Promise<T>
): Promise<T> {
  let held: string | undefined;
  let adopted = false;
  const owner: CapturedSourceOwner = {
    hold: prepared => {
      held = prepared.anchor.root;
    },
    adopt: () => {
      adopted = true;
    },
  };
  try {
    return await body(owner);
  } finally {
    // Adoption MOVES the capture, so reclaiming an adopted one is a no-op even if the
    // flag were wrong. That is what makes running this unconditionally safe.
    if (held && !adopted) {
      await rm(held, { recursive: true, force: true }).catch((err: Error) => {
        getLog().warn({ err, captureRoot: held }, 'workflow.source_capture_dispose_failed');
      });
    }
  }
}

/**
 * The graph a run must continue with, read from the source IT recorded.
 *
 * Every continuation surface goes through here — `/workflow resume`, `approve`, `reject`,
 * the console Resume button, and `workflow run --resume`. That is the point. Before this
 * existed each surface discovered the graph itself and had to remember to pass the
 * capture's roots, and the ones nobody rewrote kept discovering live: the executor then
 * supplied commands and scripts from the frozen capture while the DAG came from whatever
 * the target held now. Editing a workflow between pause and resume silently ran the new
 * graph against the old command bytes.
 *
 * A single entry point makes that unforgettable rather than merely fixed once.
 *
 * Returns `undefined` only for a run created before captures existed — nothing recorded,
 * so the caller keeps its old live behavior. THROWS when a run recorded a source that
 * cannot be read, verified, or no longer contains its workflow: a run that froze its
 * source must continue with that source or stop.
 *
 * The full discovery result comes back with it so a caller that needs the other entries —
 * parse warnings, load errors, source counts — does not run discovery a second time over
 * the same roots.
 */
export async function resolveContinuationWorkflow(
  deps: WorkflowDeps,
  run: Pick<WorkflowRun, 'workflow_name' | 'metadata'>,
  /** Target workspace — owns config; never the source. */
  cwd: string
): Promise<ResolvedContinuation | undefined> {
  // Verifies the digest against the value the RUN recorded, and yields the manifest whose
  // `source_config` decides how those bytes resolve. Reading the root without the config
  // is what made a repo with a custom `commands.folder` re-discover a different DAG.
  const capture = await resolveRunSourceCapture(run.metadata);
  if (!capture) return undefined; // predates capture — the caller keeps live behavior
  const roots = capturedSourceRoots(capture.anchor);

  const { workflows, errors } = await discoverWorkflowsWithConfig(
    cwd,
    deps.loadConfig,
    deps.providers,
    roots
  );
  const workflow = workflows.find(entry => entry.workflow.name === run.workflow_name)?.workflow;
  if (!workflow) {
    const readErrors = errors.filter(error => error.errorType === 'read_error');
    // Incomplete discovery cannot prove that the verified capture lacks the workflow.
    if (readErrors.length > 0) {
      throw new Error(
        `Cannot continue run of '${run.workflow_name}': captured source discovery at ` +
          `${capture.anchor.root} could not finish reading its workflows.`,
        { cause: readErrors }
      );
    }
    throw new WorkflowSourceIntegrityError(
      `Cannot continue run of '${run.workflow_name}': its captured source at ` +
        `${capture.anchor.root} no longer contains that workflow.`,
      capture.anchor.root
    );
  }
  return { workflow, roots, workflows, errors };
}

/** What a continuation resolved to, plus the discovery it already paid for. */
export interface ResolvedContinuation {
  workflow: ResolvedWorkflow;
  roots: WorkflowSourceRoots;
  workflows: readonly WorkflowWithSource[];
  errors: readonly WorkflowLoadError[];
}

/**
 * Discard a prepared capture that will never become a run.
 *
 * Preparation happens before a workflow is selected, so several ordinary outcomes end
 * without a run: an unknown workflow name, a validation refusal, a detached dispatch that
 * hands the work to a child process. Each of those would otherwise leave a complete tree
 * under `staged-source` that nothing ever reclaims — the capture is only adopted into the
 * run's artifacts once a run exists to own it.
 *
 * Best-effort: a failure to clean up must never mask the reason the run stopped.
 */
export async function disposeWorkflowSource(prepared: { captureRoot: string }): Promise<void> {
  await rm(prepared.captureRoot, { recursive: true, force: true }).catch((err: Error) => {
    getLog().warn(
      { err, captureRoot: prepared.captureRoot },
      'workflow.source_capture_dispose_failed'
    );
  });
}

/**
 * Move a staged capture to its final home, early.
 *
 * `executeWorkflow` normally does this itself once it has resolved the run's paths. One
 * caller cannot wait: a container fixes its bind mounts at `docker run`, which happens
 * during isolation preparation — before the run row exists — and mounting the staging
 * path would bind a directory that is about to move. Callers preparing a container
 * finalize here first, then mount the returned path.
 *
 * Idempotent: `executeWorkflow` recomputes the same destination and skips the move.
 */
export async function finalizeWorkflowSource(
  deps: WorkflowDeps,
  prepared: PreparedWorkflowSource,
  opts: { cwd: string; codebaseId?: string }
): Promise<PreparedWorkflowSource> {
  const { workflowSourceDir: finalRoot } = await resolveProjectPaths(
    deps,
    opts.cwd,
    prepared.runId,
    opts.codebaseId
  );
  if (finalRoot === prepared.anchor.root) return prepared;
  await mkdir(dirname(finalRoot), { recursive: true });
  await rm(finalRoot, { recursive: true, force: true });
  await rename(prepared.anchor.root, finalRoot);
  const anchor = { ...prepared.anchor, root: finalRoot };
  return {
    ...prepared,
    anchor,
    roots: capturedSourceRoots(anchor),
  };
}

/** Build the durable source pointer for a capture already moved to its final run path. */
export function preparedWorkflowSourceRecord(
  prepared: PreparedWorkflowSource
): WorkflowSourceMetadata {
  return {
    version: 1,
    root: prepared.anchor.root,
    origin: prepared.origin,
    captured_at: prepared.manifest.captured_at,
    digest: prepared.manifest.digest,
    source_config: prepared.anchor.config,
    file_count: prepared.manifest.file_count,
    byte_count: prepared.manifest.byte_count,
  };
}

/**
 * Freeze a run's executable source and reserve the run id it belongs to, BEFORE the
 * workflow is discovered.
 *
 * Order is the whole point. Discovering first and capturing afterwards leaves a window
 * where the YAML a run executes and the scripts it calls come from two different moments;
 * capturing first and discovering from the capture closes it. Callers should therefore:
 *
 *   1. `prepareWorkflowSource(...)`
 *   2. discover with `discoverWorkflowsWithConfig(cwd, loadConfig, prepared.roots)`
 *   3. `recordSelectedWorkflow(prepared.anchor.root, workflow.name)`
 *   4. `executeWorkflow(..., { preparedSource: prepared })`
 *
 * Throws when the source cannot be frozen. There is no degraded mode: a run with no
 * capture has no established executable source.
 */
export async function prepareWorkflowSource(
  deps: Pick<WorkflowDeps, 'loadConfig'>,
  opts: {
    /** Directory to freeze. */
    sourceRoot: string;
    /**
     * File the capture under an id the caller already owns instead of reserving a new
     * one. Set when the run row exists before its source is frozen — a `--detach` child
     * whose parent created the row (#2872) — so the capture and the row still agree.
     */
    runId?: string;
    /** Installed packs to freeze instead of the live installs; see `captureWorkflowSource`. */
    installedFrom?: InstalledPacksRoot;
  }
): Promise<PreparedWorkflowSource> {
  // Read the SOURCE's command policy, not the target's. A repo may point `commands.folder`
  // somewhere outside `.archon/commands`; discovery honors that, so a capture that did not
  // would find the command at selection time and lose it at execution time. Resolved here
  // rather than passed in so no caller can forget it.
  let sourceConfig: WorkflowSourceConfig;
  try {
    sourceConfig = workflowSourceConfigFrom(await deps.loadConfig(opts.sourceRoot));
  } catch (error) {
    if (isSourceReadFailure(error)) throw error;
    // A malformed config would otherwise silently narrow what gets frozen.
    throw new Error(
      `Cannot capture workflow source from ${opts.sourceRoot}: its configuration could not ` +
        `be read (${(error as Error).message}).`,
      { cause: error }
    );
  }
  await sweepStaleStagedSources();
  const runId = opts.runId ?? randomUUID();
  // Staged, not final. The run's source path depends on its registered project
  // identity, which the caller often has not resolved yet at capture time — and looking
  // it up early would duplicate a lookup the run does properly later. Staging under
  // ARCHON_HOME keeps the capture on the same filesystem, so `executeWorkflow` moves it
  // to `<workflow-source>/runs/<id>` with a rename once the real path is known. The
  // bytes never change, so the digest taken here still describes the final capture.
  const capture = await captureWorkflowSource({
    sourceRoot: opts.sourceRoot,
    captureRoot: join(archonPaths.getArchonHome(), 'staged-source', runId),
    commandFolder: sourceConfig.command_folder,
    sourceConfig,
    ...(opts.installedFrom !== undefined ? { installedFrom: opts.installedFrom } : {}),
  });
  return {
    runId,
    origin: capture.origin,
    manifest: capture.manifest,
    anchor: capture.anchor,
    roots: capturedSourceRoots(capture.anchor),
  };
}

/**
 * Validate adoption before source setup can stop the run, then establish the source.
 * A refused adoption skips source setup and does not stop the run here: `adoptedRunDir`
 * rethrows the refusal, so the caller fails the admitted run inside its own failure
 * boundary. Source setup keeps its own exits.
 */
export async function establishAdoptedRunSource(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  workflowSourceDir: string,
  opts: Pick<
    ExecuteWorkflowOptions,
    | 'adoptedFromRunId'
    | 'continuationMode'
    | 'priorCompletedNodes'
    | 'preparedSource'
    | 'capturedSourceOwner'
  >,
  isContinuation: boolean
): Promise<
  RunPhase<{
    adoptedRunDir: () => string | undefined;
    workflowSourceRoots: WorkflowSourceRoots | undefined;
  }>
> {
  let adoptedRunDir: string | undefined;
  try {
    adoptedRunDir = await resolveAdoptedRunDir(deps, workflowRun, opts, isContinuation);
  } catch (refusal) {
    const rethrowRefusal = (): never => {
      throw refusal;
    };
    return {
      stopped: false,
      value: { adoptedRunDir: rethrowRefusal, workflowSourceRoots: undefined },
    };
  }
  const sourced = await establishRunSource(
    deps,
    platform,
    conversationId,
    workflowRun,
    workflowSourceDir,
    opts
  );
  if (sourced.stopped) return sourced;
  return {
    stopped: false,
    value: { adoptedRunDir: () => adoptedRunDir, workflowSourceRoots: sourced.value },
  };
}

/**
 * Freeze the workflow's own commands and scripts into this run's artifacts, and
 * resolve them from there for the rest of the run. Two things follow: the target
 * workspace never receives authoring files (it used to get a whole `.archon` copy,
 * `.env` and all), and the run stops changing shape when the authoring checkout is
 * edited, moved, or deleted underneath it.
 *
 * Order matters. A run that already RECORDED a source uses it, always — that is what
 * makes a resume deterministic. Only a run with no record captures, so a resume can
 * never recapture and quietly pull in edits made since it paused.
 *
 * This path FAILS CLOSED. A capture that cannot be taken, recorded, or verified means
 * the run's executable source cannot be established, and running anyway would execute
 * something other than what the run is supposed to be — the exact drift the capture
 * exists to remove. The sole exception is a run created before captures existed, which
 * has no record to honor.
 */
export async function establishRunSource(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  workflowSourceDir: string,
  opts: Pick<
    ExecuteWorkflowOptions,
    'priorCompletedNodes' | 'preparedSource' | 'capturedSourceOwner'
  >
): Promise<RunPhase<WorkflowSourceRoots | undefined>> {
  const recordedSourceState = readWorkflowSourceState(workflowRun.metadata);
  const isResume = opts.priorCompletedNodes !== undefined;
  const { preparedSource } = opts;
  let workflowSourceRoots: WorkflowSourceRoots | undefined;

  const failRunOnSource = async (message: string): Promise<RunPhase<never>> => {
    getLog().error({ workflowRunId: workflowRun.id, message }, 'workflow.source_unavailable');
    await sendCriticalMessage(platform, conversationId, `❌ **Workflow failed**: ${message}`);
    await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(workflowRun.id, message, { exitReason: 'source_unavailable' }),
      {
        workflowRunId: workflowRun.id,
        site: 'workflow.source_fail_db_record_failed',
      }
    );
    return {
      stopped: true,
      result: { success: false, workflowRunId: workflowRun.id, error: message },
    };
  };

  if (recordedSourceState.kind === 'unreadable') {
    // The run recorded SOMETHING this build cannot parse. Not the legacy case: treating
    // it as one would resume against whatever is on disk now.
    return await failRunOnSource(
      "This run's workflow source record cannot be read by this build " +
        `(${recordedSourceState.detail}). It may have been written by a newer Archon. ` +
        'Start a fresh run to execute the current workflow.'
    );
  } else if (recordedSourceState.kind === 'recorded') {
    const recordedSource = recordedSourceState.record;
    // Verifies the digest against the one the RUN recorded — not merely that the
    // directory exists, and not merely that the capture agrees with itself.
    let loaded: WorkflowSourceCapture;
    try {
      const capture = await resolveRunSourceCapture(workflowRun.metadata);
      if (!capture) throw new Error('workflow source record disappeared during resolution');
      loaded = capture;
    } catch (error) {
      if (isSourceReadFailure(error)) {
        const path =
          error instanceof WorkflowSourceUnavailableError ? error.path : recordedSource.root;
        getLog().warn(
          { workflowRunId: workflowRun.id, path, err: error },
          'workflow.source_restore_unreadable'
        );
        const { released } = await deps.store.releaseRunForUnreadableSource(workflowRun.id, {
          claimId: executionClaim(workflowRun.metadata),
          nodeId: 'workflow-source',
          path,
          error: error instanceof Error ? error.message : String(error),
          retryAt: new Date(Date.now() + CONTINUATION_RETRY_MS).toISOString(),
        });
        if (released) {
          await safeSendMessage(
            platform,
            conversationId,
            sourceReleaseNotice(platform, workflowRun.id, {
              path,
              container: isContainerRun(workflowRun),
            })
          );
          return {
            stopped: true,
            result: { success: true, paused: true, workflowRunId: workflowRun.id },
          };
        }
        const current = await readWorkflowLifecycle(workflowRun.id, () =>
          deps.store.getWorkflowRun(workflowRun.id)
        );
        if (current?.status === 'paused') {
          return {
            stopped: true,
            result: { success: true, paused: true, workflowRunId: workflowRun.id },
          };
        }
        if (current?.status === 'completed') {
          return { stopped: true, result: { success: true, workflowRunId: workflowRun.id } };
        }
        return {
          stopped: true,
          result: {
            success: false,
            workflowRunId: workflowRun.id,
            error: 'Workflow status changed before source release',
          },
        };
      }
      return await failRunOnSource(
        `This run's captured workflow source at ${recordedSource.root} is missing or altered ` +
          `(${(error as Error).message}). The run cannot be resumed against different source; ` +
          'start a fresh run to execute the current workflow.'
      );
    }
    workflowSourceRoots = capturedSourceRoots(loaded.anchor);
    getLog().debug(
      { workflowRunId: workflowRun.id, captureRoot: recordedSource.root },
      'workflow.source_restored'
    );
    if (recordedSource.source_config === undefined) {
      // A run from before the row carried `source_config`. The manifest sits outside
      // the digest, so nothing can prove these settings are the ones the run started
      // with; what pinning them now buys is closing the window. From here on they are
      // held beside the digest, and a later edit to the manifest is refused like any
      // other drift instead of being re-read on every resume for the life of the run.
      const pinned = { ...recordedSource, source_config: loaded.anchor.config };
      workflowRun.metadata = { ...workflowRun.metadata, [WORKFLOW_SOURCE_METADATA_KEY]: pinned };
      await deps.store.updateWorkflowRun(workflowRun.id, {
        metadata: { [WORKFLOW_SOURCE_METADATA_KEY]: pinned },
      });
      getLog().warn(
        { workflowRunId: workflowRun.id, captureRoot: recordedSource.root },
        'workflow.source_config_pinned_from_manifest'
      );
    }
  } else if (isResume) {
    // Created before source capture existed. Its original bytes were never recorded and
    // cannot be reconstructed, so it resumes the way it always did — against live source.
    // This is the ONLY warning-and-continue path, and it retires with those runs.
    getLog().warn({ workflowRunId: workflowRun.id }, 'workflow.source_legacy_live');
    await safeSendMessage(
      platform,
      conversationId,
      '⚠️ This run started before Archon captured workflow source, so there is nothing ' +
        'recorded to resume from. Continuing against the current source on disk, which may ' +
        'differ from what the run originally executed.'
    );
  } else if (preparedSource) {
    // The normal fresh path: the caller captured BEFORE selecting a workflow and
    // discovered from that capture, so the YAML being executed and the commands and
    // scripts beside it are one consistent set of bytes.
    //
    // Move the staged capture to this run's own source directory, so it stops
    // accumulating in a staging directory nothing reclaims. That directory sits BESIDE
    // the run's artifacts, not inside them: `$ARTIFACTS_DIR` is handed to every node and
    // listed as the run's output, and the frozen pack is neither an output nor something
    // a node should reach by that path. Same filesystem, so this is a rename.
    const finalCaptureRoot = workflowSourceDir;
    try {
      if (preparedSource.anchor.root !== finalCaptureRoot) {
        // Unlike `artifactsDir`, nothing earlier in the run creates this parent.
        await mkdir(dirname(finalCaptureRoot), { recursive: true });
        await rm(finalCaptureRoot, { recursive: true, force: true });
        await rename(preparedSource.anchor.root, finalCaptureRoot);
      }
      // The staged capture is now at the run's own source path — the run owns the
      // bytes from this point on. Adopting here (not earlier, at the call site) is
      // what closes the race in #2690: a rename failure above returns without reaching
      // this line, so the wrap's `finally` reclaims the staged directory instead of
      // leaving it to the hourly age-based sweep.
      opts.capturedSourceOwner?.adopt();
    } catch (error) {
      return await failRunOnSource(
        `Could not move this run's captured workflow source into place: ${(error as Error).message}`
      );
    }
    const sourceAnchor = { ...preparedSource.anchor, root: finalCaptureRoot };
    workflowSourceRoots = capturedSourceRoots(sourceAnchor);
    const sourceRecord = preparedWorkflowSourceRecord({
      ...preparedSource,
      anchor: sourceAnchor,
    });
    // Mirror the record onto the IN-MEMORY run as well as the row. `workflowRun` is what
    // gets handed to child, fan-out, and `workflow:` dispatch, and those read the record
    // to find the parent's authoring origin — a stale in-memory copy sends them to the
    // target `cwd`, where the authoring workflows may not exist at all. Mutated rather
    // than reassigned so the row object stays one identity for the rest of the run; the
    // value written here is the same one the row is about to receive.
    workflowRun.metadata = {
      ...workflowRun.metadata,
      [WORKFLOW_SOURCE_METADATA_KEY]: sourceRecord,
    };
    try {
      await deps.store.updateWorkflowRun(workflowRun.id, {
        metadata: { [WORKFLOW_SOURCE_METADATA_KEY]: sourceRecord },
      });
    } catch (error) {
      // Without the pointer the run is unresumable in the only way that matters: a later
      // resume would find no record and fall through the legacy branch, executing live
      // source. Fail now, while the failure is attributable.
      return await failRunOnSource(
        `Could not record this run's workflow source: ${(error as Error).message}`
      );
    }
    getLog().info(
      {
        workflowRunId: workflowRun.id,
        origin: preparedSource.origin,
        captureRoot: finalCaptureRoot,
        digest: preparedSource.manifest.digest.slice(0, 12),
        fileCount: preparedSource.manifest.file_count,
        byteCount: preparedSource.manifest.byte_count,
      },
      'workflow.source_captured'
    );
  } else {
    // A fresh run whose caller did not prepare a capture. In-process callers that hand
    // the executor a definition they built themselves (tests, programmatic embedders)
    // land here; they have no on-disk source to freeze, so there is nothing to record
    // and nothing that can drift. Resolution stays live under `cwd`, unchanged.
    getLog().debug({ workflowRunId: workflowRun.id }, 'workflow.source_unprepared_live');
  }
  return { stopped: false, value: workflowSourceRoots };
}
