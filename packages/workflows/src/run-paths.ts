import * as archonPaths from '@archon/paths';
import { createLogger } from '@archon/paths';
import type { WorkflowDeps } from './deps';
import { runMayPersistSessions, type DagNode, type IncludeDirective } from './schemas';

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
