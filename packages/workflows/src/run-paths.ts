import * as archonPaths from '@archon/paths';
import { createLogger } from '@archon/paths';
import { mkdir } from 'fs/promises';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import { sendCriticalMessage, type RunPhase } from './executor-shared';
import {
  RUN_METADATA_KEYS,
  persistScopeKey,
  readContinuationMode,
  readIdentityUnresolved,
  runMayPersistSessions,
  type DagNode,
  type IncludeDirective,
  type ResolvedWorkflow,
  type WorkflowRun,
} from './schemas';
import { maybeWarnLegacyArtifactsPath, maybeWarnLegacyStatePath } from './state-migration';
import { requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * Whether the run's codebase is a folder project (no Archon-managed git). Folder projects run
 * in place and leave git to the user and agent, even when the directory has git.
 * Skip git base-branch inference for these projects. `$BASE_BRANCH` keeps its
 * referenced-but-unresolvable failure semantics (empty string when skipped).
 *
 * Contract: NEVER THROWS. A lookup failure returns `false` so the normal
 * auto-detection path still runs, preserving prior behavior on any DB hiccup.
 */
export async function isFolderCodebase(
  deps: WorkflowDeps,
  codebaseId: string | undefined
): Promise<boolean> {
  if (!codebaseId) return false;
  try {
    const codebase = await deps.store.getCodebase(codebaseId);
    return codebase?.kind === 'folder';
  } catch (err) {
    getLog().warn({ err: err as Error, codebaseId }, 'workflow.folder_kind_resolve_failed');
    return false;
  }
}

/** The run-scoped output directories plus the project root they hang off. */
export interface ResolvedProjectPaths {
  artifactsDir: string;
  /** Where this run's frozen workflow source lives — beside `artifactsDir`, never inside it. */
  workflowSourceDir: string;
  logDir: string;
  artifactsRoot: string;
  /** `$STATE_DIR` — per-PROJECT cross-run state, shared by every workflow. */
  stateDir: string;
  /** The project root persisted to `workflow_runs.output_root`. */
  outputRoot: string;
  /**
   * How the run's project identity was determined (#2304). Three states; collapsing
   * any two is a correctness bug:
   *  - `'resolved'`     — `getCodebase` returned a row whose identity resolves to a
   *                      repo / folder / `_local` key.
   *  - `'unregistered'` — `getCodebase` returned a row, but no owner/repo nor a
   *                      `_local` identity could be derived from it; the run still
   *                      gets external storage, keyed on cwd (`codebase_project_identity_unresolved`
   *                      WARN). This is a legitimate outcome of a registered codebase,
   *                      NOT a fault.
   *  - `'faulted'`      — `getCodebase` threw on BOTH retry attempts; the run fell
   *                      through to the cwd fallback (`project_paths_resolve_failed_using_fallback`
   *                      ERROR). The persistence block must NOT write `output_root`
   *                      for these runs — see `executeWorkflow`.
   *
   * Undefined on the persisted-`output_root` short-circuit branch (a resume reading
   * an existing root re-derives nothing and there is nothing to flag).
   */
  identityResolution?: 'resolved' | 'unregistered' | 'faulted';
}

/**
 * Resolve the output directories for a workflow run.
 *
 * Resolution order:
 *  1. A persisted `output_root` (from the run row) wins outright — a run that
 *     already recorded where its output lives must never re-derive it, or a
 *     renamed codebase (#1192) would orphan its artifacts mid-run.
 *  2. Otherwise look the codebase up once and delegate to the single shared
 *     identity→paths resolver in `@archon/paths`, which handles repo,
 *     `_local`, and folder projects.
 *  3. With no codebase (or a lookup failure, or an unresolvable identity) the
 *     run falls back to the `_cwd/<basename>` pseudo-project — still UNDER
 *     `ARCHON_HOME`. This used to write into `<cwd>/.archon/`, i.e. the user's
 *     repository; relocating it is the breaking change accepted in #2200 so
 *     that every run's output survives worktree teardown and is retrievable.
 *
 * `artifactsRoot` is the parent of the `runs/` layout (`.../artifacts`) — the base
 * that run-scoped (`runs/<id>/`) and scope-scoped (`scopes/<workflow>/<scope>/`,
 * #1846) storage both hang off, whichever branch resolved it.
 *
 * Exported for unit testing of the kind-based branch selection.
 */
export async function resolveProjectPaths(
  deps: { store: Pick<WorkflowDeps['store'], 'getCodebase'> },
  cwd: string,
  workflowRunId: string,
  codebaseId?: string,
  opts?: { persistedOutputRoot?: string | null }
): Promise<ResolvedProjectPaths> {
  if (opts?.persistedOutputRoot) {
    // The engine only ever persists an in-tree root, so an out-of-tree value is
    // corruption or a hand edit. Acting on it would let a relative or
    // whitespace root scatter this run's artifacts AND its shared state under
    // whatever the server's cwd happens to be. Ignore it and re-derive: the run
    // still lands somewhere correct, and the write-once guard means we never
    // overwrite the bad value silently. Readers apply the same boundary.
    if (archonPaths.isInsideArchonHome(opts.persistedOutputRoot)) {
      return composeRunPaths(
        archonPaths.getStoragePathsForRoot(opts.persistedOutputRoot),
        workflowRunId
      );
    }
    getLog().error(
      { workflowRunId, persistedOutputRoot: opts.persistedOutputRoot },
      'workflow.output_root_outside_archon_home'
    );
  }

  let key: archonPaths.ProjectStorageKey | undefined;
  let identityResolution: 'resolved' | 'unregistered' | 'faulted' | undefined;
  if (codebaseId) {
    // Retried once (#2304). A failing lookup drops the run onto the `_cwd/<basename>`
    // pseudo-project. The fallback itself stays — a registry blip must not kill a run.
    // What changed is what happens to the row afterwards: a faulted run no longer
    // has its fault-derived location PERSISTED as `output_root` (so the rename hazard
    // #1192 protects stays scoped to rows with real roots), and the run carries
    // `metadata.identity_unresolved = true` so "unregistered" and "we could not tell"
    // are distinguishable after the fact. See the persistence block in `executeWorkflow`
    // and `ResolvedProjectPaths.identityResolution`.
    //
    // The retry is for Postgres: a stale or broken pooled connection is exactly the
    // fault an immediate retry clears by drawing a fresh one, so zero delay is correct.
    // SQLite never surfaces SQLITE_BUSY here: its adapter waits out busy locks itself.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const codebase = await deps.store.getCodebase(codebaseId);
        if (codebase) {
          key = archonPaths.resolveProjectStorageKey(codebase, cwd);
          identityResolution = key.kind === 'cwd' ? 'unregistered' : 'resolved';
          if (key.kind === 'cwd') {
            // The codebase exists but neither an owner/repo nor a _local identity
            // could be derived from it — the run still gets external storage, but
            // keyed on the working directory rather than the project. NOT a fault;
            // the persistence block writes the cwd fallback as `output_root` here.
            getLog().warn(
              { codebaseName: codebase.name, cwd: codebase.default_cwd },
              'codebase_project_identity_unresolved'
            );
          }
        }
        break;
      } catch (error) {
        if (attempt === 0) {
          getLog().warn(
            { err: error as Error, codebaseId, cwd },
            'workflow.project_paths_lookup_retrying'
          );
          continue;
        }
        identityResolution = 'faulted';
        getLog().error(
          { err: error as Error, codebaseId, cwd },
          'project_paths_resolve_failed_using_fallback'
        );
      }
    }
  }

  // When the lookup returned null (no codebase row) or no `codebaseId` was provided,
  // `key` is undefined and the cwd fallback is used. Both are legitimate — neither is
  // a fault — so they read as `'unregistered'`. A `'faulted'` outcome overrides this.
  if (identityResolution === undefined) {
    identityResolution = 'unregistered';
  }

  return {
    ...composeRunPaths(
      archonPaths.getProjectStoragePaths(key ?? { kind: 'cwd', cwd }),
      workflowRunId
    ),
    identityResolution,
  };
}

/** Project-level roots → the run-scoped view the executor threads downstream. */
function composeRunPaths(
  storage: archonPaths.ProjectStoragePaths,
  workflowRunId: string
): ResolvedProjectPaths {
  return {
    artifactsDir: archonPaths.getRunArtifactsDirForRoot(storage.root, workflowRunId),
    workflowSourceDir: archonPaths.getRunWorkflowSourceDirForRoot(storage.root, workflowRunId),
    logDir: storage.logsDir,
    artifactsRoot: storage.artifactsRoot,
    stateDir: storage.stateRoot,
    outputRoot: storage.root,
  };
}

/**
 * Resolve the stable cross-invocation artifact scope dir for a run (#1846), or
 * undefined when the feature doesn't apply. Applies only when the run may use
 * cross-run session persistence (`runMayPersistSessions`) AND the run has a scope
 * (`persistScopeKey`) — the same opt-in + scope key the session store uses. No persistence → no new dirs,
 * default behavior unchanged.
 */
export function resolveScopeArtifactsDir(
  workflow: {
    name: string;
    nodes: readonly (DagNode | IncludeDirective)[];
    persist_sessions?: boolean;
  },
  scopeKey: string | null | undefined,
  artifactsRoot: string
): string | undefined {
  if (!scopeKey) return undefined;
  if (!runMayPersistSessions(workflow)) return undefined;
  return archonPaths.getScopeArtifactsPath(artifactsRoot, workflow.name, scopeKey);
}

export interface PreparedRunPaths {
  artifactsDir: string;
  workflowSourceDir: string;
  logDir: string;
  stateDir: string;
  outputRoot: string;
  scopeArtifactsDir: string | undefined;
}

/**
 * Resolve the run's output directories, record its output root, warn about legacy
 * repo-local output, and create the directories its nodes write to. A directory that
 * cannot be created fails the run.
 */
export async function prepareRunPaths(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  codebaseId: string | undefined
): Promise<RunPhase<PreparedRunPaths>> {
  // Resolve external artifact, log, and state directories. A resumed run
  // carries its `output_root` and short-circuits identity resolution entirely.
  const {
    artifactsDir,
    workflowSourceDir,
    logDir,
    artifactsRoot,
    stateDir,
    outputRoot,
    identityResolution,
  } = await resolveProjectPaths(deps, cwd, workflowRun.id, codebaseId, {
    persistedOutputRoot: workflowRun.output_root,
  });

  await persistRunOutputRoot(deps, workflowRun, outputRoot, identityResolution);

  // Detect (never move) legacy repo-local `.archon/` output directories. State was a
  // prompt convention; artifacts/logs the engine wrote itself on the unregistered-cwd
  // fallback (#2311) — the case Archon caused must not be the quieter of the two.
  // The run's ACTUAL posture, not the workflow's declared policy. `worktree.enabled`
  // is only one input to the real decision (`pinnedEnabled ?? (!resume && !noWorktree)`,
  // resolved in the CLI), so a workflow that leaves `worktree` unset and is run with
  // `--no-worktree` executes IN PLACE while the declared policy still reads as isolated.
  // That is the one case where this warning is actionable — the legacy files are sitting
  // in the user's real repository — and it is exactly the case the declared policy gets
  // backwards. A managed worktree always lives under ARCHON_HOME; an in-place checkout
  // never does, so the cwd answers the question the policy cannot.
  const isolated = archonPaths.isInsideArchonHome(cwd);
  await maybeWarnLegacyStatePath(cwd, stateDir, isolated);
  await maybeWarnLegacyArtifactsPath(cwd, artifactsRoot, isolated);

  // Stable cross-invocation artifact scope (#1846): only for persist_session
  // workflows, keyed like the session store. Undefined otherwise — zero new dirs.
  const scopeArtifactsDir = resolveScopeArtifactsDir(
    workflow,
    persistScopeKey(workflowRun),
    artifactsRoot
  );

  // Pre-create the artifacts directory so commands can write to it immediately
  // (and the durable scope dir, when the workflow opted into one — same disk,
  // same failure mode, same fatal treatment). `stateDir` is pre-created here
  // too so `$STATE_DIR` is usable from the first node without an mkdir, and an
  // unwritable state dir fails the run rather than silently degrading.
  try {
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    if (scopeArtifactsDir) await mkdir(scopeArtifactsDir, { recursive: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      { err, artifactsDir, stateDir, workflowRunId: workflowRun.id },
      'workflow.artifacts_dir_create_failed'
    );
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: Could not create artifacts directory \`${artifactsDir}\`: ${err.message}`
    );
    await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(
        workflowRun.id,
        `Artifacts directory creation failed: ${err.message}`
      ),
      { workflowRunId: workflowRun.id, site: 'workflow.artifacts_dir_fail_db_record_failed' }
    );
    return {
      stopped: true,
      result: {
        success: false,
        workflowRunId: workflowRun.id,
        error: `Artifacts directory creation failed: ${err.message}`,
      },
    };
  }
  getLog().debug({ artifactsDir, logDir, stateDir, outputRoot }, 'workflow_paths_resolved');

  return {
    stopped: false,
    value: { artifactsDir, workflowSourceDir, logDir, stateDir, outputRoot, scopeArtifactsDir },
  };
}

/**
 * Record the resolved root ONCE, so every later reader (artifact routes, CLI)
 * addresses this run's output by a durable pointer instead of re-deriving it
 * from a codebase name that may since have been renamed (#1192). Never
 * overwritten — a resumed run already has one, and the store additionally
 * enforces write-once via COALESCE.
 *
 * Faulted-identity exception (#2304): when `resolveProjectPaths` returned the
 * cwd fallback BECAUSE both `getCodebase` attempts threw (not because a registered
 * codebase simply lacked an owner/repo or `_local` identity), the cwd location is
 * fault-shaped — persisting it here would pin this run's `output_root` AND
 * `$STATE_DIR` to that empty, fault-derived tree for the run's whole life. We
 * instead leave `output_root` NULL and stamp `metadata.identity_unresolved = true`,
 * so:
 *   • a later resume re-derives once the registry is healthy and the
 *     `!workflowRun.output_root` guard writes the now-correct root;
 *   • anyone reading the row can tell "unregistered" apart from "we could not
 *     tell";
 *   • the write-once invariant is preserved everywhere else (a row with a
 *     resolved or unregistered identity is still protected across a #1192
 *     rename — only the empty faulted shape is scoped differently).
 *
 * A failure to persist here is NOT retried: the guard is `if (!output_root)`, so
 * this run keeps a NULL pointer for its whole lifetime and permanently stays on
 * the re-derive path — the exact orphaning #1192 makes possible. That does not
 * justify failing an otherwise healthy run (re-derivation works today), but it
 * is a durable per-run degradation, so the healed-arm persist failure
 * (`workflow.output_root_persist_failed`) logs at ERROR rather than WARN. The
 * faulted arm's two logs stay at WARN by design: the underlying fault was
 * already logged at ERROR inside `resolveProjectPaths`, so these only report a
 * secondary bookkeeping failure (stamping the flag, noting the skipped persist),
 * not the fault itself.
 */
async function persistRunOutputRoot(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  outputRoot: string,
  identityResolution: ResolvedProjectPaths['identityResolution']
): Promise<void> {
  if (workflowRun.output_root) return;
  if (identityResolution === 'faulted') {
    workflowRun.metadata = {
      ...workflowRun.metadata,
      [RUN_METADATA_KEYS.identityUnresolved]: true,
    };
    try {
      await deps.store.updateWorkflowRun(workflowRun.id, {
        metadata: { [RUN_METADATA_KEYS.identityUnresolved]: true },
      });
    } catch (err) {
      getLog().warn(
        { err: err as Error, workflowRunId: workflowRun.id },
        'workflow.identity_unresolved_flag_persist_failed'
      );
    }
    getLog().warn(
      { workflowRunId: workflowRun.id, outputRoot },
      'workflow.output_root_not_persisted_identity_faulted'
    );
  } else {
    const updates: Parameters<typeof deps.store.updateWorkflowRun>[1] = {
      output_root: outputRoot,
    };
    // The faulted arm stamped `identity_unresolved = true`; this is the heal
    // half of the same write — once a later resume's identity lookup succeeds,
    // a row that has healed must stop reading as faulted. The `false` rides the
    // same atomic metadata merge as the faulted arm's `true`.
    if (readIdentityUnresolved(workflowRun.metadata) === true) {
      updates.metadata = { [RUN_METADATA_KEYS.identityUnresolved]: false };
    }
    await deps.store
      .updateWorkflowRun(workflowRun.id, updates)
      .then(() => {
        // Keep the in-memory row in step with the write, exactly as the faulted arm
        // does for `identity_unresolved`. Every in-run reader of `output_root` — the
        // artifact-pointer gate (#2453) is the first — would otherwise see NULL on the
        // very run that just recorded its own location, and only agree with the
        // database after a resume reloaded the row.
        workflowRun.output_root = outputRoot;
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, outputRoot },
          'workflow.output_root_persist_failed'
        );
      });
  }
}

/**
 * Between-run continuation (#2747): resolve $ADOPTED_RUN_DIR through the
 * adopted run's persisted `output_root` (rename-safe per #2200) and announce
 * the continuation on THIS run's own event log so the chain renders without a
 * column join. Read-only by contract — this run writes to its own artifacts;
 * stores are never merged, so evidence stays attributable per run.
 * Resolution also runs on resume: a resumed run carries no caller-supplied id,
 * but its row still records the continuation, and every remaining node may
 * reference $ADOPTED_RUN_DIR (only for adoption; supersession has no estate).
 * Only the announcement event stays creation-only — it was written once when
 * the continuation was made.
 */
export async function resolveAdoptedRunDir(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  {
    adoptedFromRunId,
    continuationMode,
  }: Pick<ExecuteWorkflowOptions, 'adoptedFromRunId' | 'continuationMode'>,
  isContinuation: boolean
): Promise<string | undefined> {
  const effectiveAdoptedFromRunId = adoptedFromRunId ?? workflowRun.adopted_from_run_id;
  // On a fresh invocation the caller supplies the mode alongside the id. On
  // resume neither is in opts — the executor reads the row's metadata stamp.
  const effectiveContinuationMode =
    continuationMode ?? readContinuationMode(workflowRun.metadata) ?? 'adopt';
  if (!effectiveAdoptedFromRunId) return undefined;
  let adoptedRunDir: string | undefined;
  // Supersession is metadata-only (#3064): no estate, so skip the output_root
  // gate and the $ADOPTED_RUN_DIR resolution that only adoption needs.
  if (effectiveContinuationMode !== 'supersede') {
    const adopted = await deps.store.getWorkflowRun(effectiveAdoptedFromRunId);
    // Deliberately precedes the resolver below: a missing persisted root is
    // corruption, not relocation, so adoption refuses rather than re-deriving
    // from a codebase row the way the display-only CLI/server readers would.
    if (!adopted?.output_root) {
      throw new Error(
        `Cannot adopt run '${effectiveAdoptedFromRunId}': it has no persisted output root, so its ` +
          'artifact directory cannot be addressed.'
      );
    }
    // #3097 — route the adopted run's persisted output_root through the
    // shared resolver so the same ARCHON_HOME containment check every other
    // persisted-root reader (CLI leave-behind, server artifact route) already
    // applies here. An out-of-tree value is refused unless the adopted run's
    // codebase row can re-derive a root under the current ARCHON_HOME.
    const adoptedCodebase = adopted.codebase_id
      ? await deps.store.getCodebase(adopted.codebase_id)
      : null;
    const adoptedRoot = archonPaths.resolveRunStorageRoot(adopted, adoptedCodebase);
    if (!adoptedRoot) {
      throw new Error(
        `Cannot adopt run '${effectiveAdoptedFromRunId}': its persisted output root is outside ARCHON_HOME and cannot be re-derived, so its artifact directory cannot be addressed.`
      );
    }
    adoptedRunDir = archonPaths.getRunArtifactsDirForRoot(adoptedRoot, effectiveAdoptedFromRunId);
  }
  if (!isContinuation) {
    try {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'workflow.run_adopted',
        data: {
          adopted_from_run_id: effectiveAdoptedFromRunId,
          mode: effectiveContinuationMode,
        },
      });
    } catch (err) {
      getLog().warn(
        { err: err as Error, workflowRunId: workflowRun.id, adoptedFromRunId },
        'workflow.run_adopted_event_persist_failed'
      );
    }
  }
  return adoptedRunDir;
}
