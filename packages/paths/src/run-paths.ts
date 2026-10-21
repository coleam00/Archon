/**
 * Run and artifact paths: where one workflow run's artifacts, transcript and
 * frozen workflow source live inside its project's storage.
 */

import { join } from 'path';
import { isInsideArchonHome } from './home-paths';
import {
  getFolderProjectArtifactsPath,
  getProjectArtifactsPath,
  getProjectRoot,
  getProjectStoragePaths,
  getStoragePathsForRoot,
  resolveProjectStorageKey,
  sanitizeScopeSegment,
} from './project-paths';
import type { ProjectStorageKey } from './project-paths';

/**
 * Get the artifacts directory for a specific workflow run.
 * Returns: ~/.archon/workspaces/owner/repo/artifacts/runs/{id}/
 */
export function getRunArtifactsPath(owner: string, repo: string, workflowRunId: string): string {
  return join(getProjectArtifactsPath(owner, repo), 'runs', workflowRunId);
}

/**
 * Get the log file path for a specific workflow run.
 * Returns: ~/.archon/workspaces/owner/repo/logs/{id}.jsonl
 */
export function getRunLogPath(owner: string, repo: string, workflowRunId: string): string {
  return getRunLogPathForRoot(getProjectRoot(owner, repo), workflowRunId);
}

/**
 * Get the stable cross-invocation artifact scope directory for a workflow +
 * scope key (the conversation UUID — the same key `persist_session` uses).
 * Lives alongside the per-run `runs/` layout under the same artifacts root, so
 * it works for repo projects, folder projects, and unregistered-cwd fallbacks:
 *
 *   <artifactsRoot>/scopes/<workflow>/<scope>/
 *
 * Unlike `runs/<id>/`, this path is identical across invocations of the same
 * workflow in the same scope — it is the durable location a later invocation
 * (e.g. a cold session resume) can read prior typed artifacts from.
 */
export function getScopeArtifactsPath(
  artifactsRoot: string,
  workflowName: string,
  scopeKey: string
): string {
  return join(
    artifactsRoot,
    'scopes',
    sanitizeScopeSegment(workflowName),
    sanitizeScopeSegment(scopeKey)
  );
}

/**
 * Resolve the durable project root for a persisted run.
 *
 * A trusted persisted root preserves the run's original project identity. An
 * out-of-tree root is stale or corrupt, so readers re-derive the project under
 * the current ARCHON_HOME when the run still has a codebase row.
 */
export function resolveRunStorageRoot(
  run: { output_root?: string | null },
  codebase: { kind?: string | null; name: string; default_cwd: string } | null | undefined
): string | null {
  if (run.output_root && isInsideArchonHome(run.output_root)) return run.output_root;
  if (!codebase?.name) return null;
  return getProjectStoragePaths(resolveProjectStorageKey(codebase, codebase.default_cwd)).root;
}

/**
 * Get the artifacts directory for one run of a project, for any storage key.
 * Equivalent to {@link getRunArtifactsPath} / {@link getFolderRunArtifactsPath}
 * for their respective kinds, and the only way to get it for `'cwd'`.
 */
export function getRunArtifactsDirForKey(key: ProjectStorageKey, workflowRunId: string): string {
  return getRunArtifactsDirForRoot(getProjectStoragePaths(key).root, workflowRunId);
}

/**
 * Get a run's artifacts directory from an already-resolved project root — the
 * branch taken when a run's `output_root` was persisted at start.
 *
 * This is the single place the `<artifactsRoot>/runs/<id>` layout is composed
 * for the persisted-root path, and it is deliberately shared by the WRITER
 * (the executor, which creates the directory) and the READERS (the artifact
 * routes and the CLI). Those drifting apart is #2200's own bug one level down:
 * a run would write its output somewhere no reader looks.
 */
export function getRunArtifactsDirForRoot(root: string, workflowRunId: string): string {
  return join(getStoragePathsForRoot(root).artifactsRoot, 'runs', workflowRunId);
}

/**
 * The engine-private child of a run's artifacts directory.
 *
 * The executor keeps its own bookkeeping here — typed-artifact listings, node
 * output spills — so a workflow's own files stay at the root of
 * `$ARTIFACTS_DIR`. Its `scratch` child ({@link getRunScratchDir}) is the one
 * place under it a workflow writes to. It is the single name shared by the WRITERS that put state
 * under it and the READERS that list a run's artifacts for a person: a writer
 * that chose its own name would land in a listing no reader excludes.
 */
export const RUN_ARTIFACTS_ENGINE_SUBDIR = '.archon';

/**
 * A run's scratch directory: `$ARTIFACTS_DIR/.archon/scratch`. A workflow puts
 * throwaway checkouts, dependency installs and other reproducible bulk here,
 * and Archon removes it once the run is completed, failed or cancelled and
 * nothing of the run can still write there (`@archon/workflows/run-scratch`).
 * Evidence a later node or the operator reads goes anywhere else in
 * `$ARTIFACTS_DIR`, which is kept.
 */
export function getRunScratchDir(artifactsDir: string): string {
  return join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'scratch');
}

/**
 * Whether an entry in a run's artifacts directory is the engine's own store,
 * which every listing shown to a person (CLI `workflow get`, the console's
 * artifacts route) leaves out. `parentRel` is the entry's parent directory
 * relative to `$ARTIFACTS_DIR`, `''` at the root.
 *
 * Only the root child is engine-owned. Any other name, dot-prefixed or not and
 * at any depth, was written by the workflow and is its output, so it is listed.
 */
export function isRunArtifactsEngineEntry(parentRel: string, name: string): boolean {
  return parentRel === '' && name === RUN_ARTIFACTS_ENGINE_SUBDIR;
}

/** Get a run's JSONL transcript from an already-resolved project root. */
export function getRunLogPathForRoot(root: string, workflowRunId: string): string {
  return join(getStoragePathsForRoot(root).logsDir, `${workflowRunId}.jsonl`);
}

/**
 * Get a run's frozen workflow source directory from an already-resolved project root:
 * `<workflowSourceRoot>/runs/<id>`. The same `runs/<id>` shape as artifacts, keyed by
 * the same run id, so one run's source and output are siblings under one project.
 */
export function getRunWorkflowSourceDirForRoot(root: string, workflowRunId: string): string {
  return join(getStoragePathsForRoot(root).workflowSourceRoot, 'runs', workflowRunId);
}

/**
 * Get the artifacts directory for a specific folder-project workflow run.
 * Returns: ~/.archon/workspaces/_folder/<slug>/artifacts/runs/{id}/
 */
export function getFolderRunArtifactsPath(slug: string, workflowRunId: string): string {
  return join(getFolderProjectArtifactsPath(slug), 'runs', workflowRunId);
}
