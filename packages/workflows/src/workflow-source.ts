/**
 * Run-owned capture of a workflow's executable SOURCE.
 *
 * Archon has always had two different directories hiding behind one `cwd`:
 *
 *   - the **source** a workflow, its commands, and its scripts are READ from, and
 *   - the **target** workspace the run ACTS on (provider turns, bash, git, output).
 *
 * Discovery reads the source; everything downstream re-derived it from the target's
 * `cwd`, so a workflow authored in checkout A but executed against worktree B looked
 * for `B/.archon/...` and found nothing. That gap was papered over by copying the
 * whole `.archon` tree into B, which dirtied B's git status, fed B's validators
 * foreign packages, and (because the copy is not scope-aware) carried `.archon/.env`
 * and megabytes of `state/` along with it.
 *
 * This module replaces that copy with a capture the RUN owns: the source directories
 * are frozen once, before the workflow is even selected, and every later lookup
 * resolves against the capture instead of the target. Two consequences matter:
 *
 *   - **The target stays clean.** Nothing is written into B at all.
 *   - **The run stops moving under itself.** Editing or deleting A mid-run cannot
 *     change the graph a paused run resumes into.
 *
 * The capture is the SOLE executable source for its run, not a convenience copy. That
 * is why a capture that cannot be taken, recorded, or verified fails the run instead of
 * degrading to live source: a silent fallback would reintroduce exactly the drift the
 * capture exists to remove. The one exception is a run created before captures existed,
 * which has no record to honor and resumes the way it always did, with a warning.
 *
 * SCOPE: every source scope a static `include:` can reach is captured — project, global
 * (`~/.archon/`), and, in source builds, the on-disk bundled defaults. Freezing only the
 * project scope would leave a hole: a project workflow that includes a global one would
 * still change shape across a resume. Bundled content is selected by the same inventory
 * in source and binary builds, then written into the run's capture so an engine upgrade
 * cannot replace its executable source. Installed workflow packs are copied too, each at
 * the commit its receipt records, so `archon plugin update` or `remove` affects only
 * runs that start afterwards.
 *
 * Runtime `workflow:` children are deliberately NOT part of the closure. A child is not a
 * run until it starts and freezes its own source — see {@link resolveChildDiscoveryRoot}.
 * The exception is installed packs: a child copies them from its parent's capture, so a
 * pack's children run at the revision its parent started with.
 *
 * This module is the public entry. The concerns live in `workflow-source/`: the roots
 * lookups resolve under (`roots.ts`), installed-pack listing (`installed-packs.ts`), taking
 * a capture (`capture.ts`, walking trees with `tree.ts` and writing the build's bundled
 * bytes with `bundled-scope.ts`), the manifest and digest (`manifest.ts`), loading and
 * verifying a capture (`load.ts`), and the read-failure types (`integrity.ts`).
 */
export { workflowSourceConfigSchema, type WorkflowSourceConfig } from './schemas/workflow-run';
export {
  capturedSourceRoots,
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
  liveSourceRoots,
  workflowSourceConfigForRoots,
  workflowSourceConfigFrom,
  type InstalledPacksRoot,
  type WorkflowSourceAnchor,
  type WorkflowSourceRoots,
} from './workflow-source/roots';
export {
  installedWorkflowName,
  listInstalledPacks,
  packagedWorkflowDirectory,
  type InstalledPack,
} from './workflow-source/installed-packs';
export {
  assertCapturedFilesPresent,
  capturedSourceReadGuard,
  isSourceReadFailure,
  isSystemError,
  WorkflowSourceIntegrityError,
  WorkflowSourceUnavailableError,
} from './workflow-source/integrity';
export type { WorkflowSourceCapture, WorkflowSourceManifest } from './workflow-source/manifest';
export { captureWorkflowSource, recordSelectedWorkflow } from './workflow-source/capture';
export {
  assertWorkflowSourceIntegrity,
  loadWorkflowSource,
  resolveChildDiscoveryRoot,
  resolveChildInstalledPacks,
  resolveRunSourceCapture,
} from './workflow-source/load';
