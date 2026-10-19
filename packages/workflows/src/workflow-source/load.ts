import { isDeepStrictEqual } from 'node:util';
import { join } from 'path';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import {
  readWorkflowSourceState,
  workflowSourceMetadataSchema,
  WORKFLOW_SOURCE_METADATA_KEY,
  type WorkflowSourceConfig,
} from '../schemas/workflow-run';
import { sourceReadError, WorkflowSourceIntegrityError } from './integrity';
import {
  digestEntries,
  foldDigest,
  readManifest,
  type DigestEntry,
  type WorkflowSourceCapture,
} from './manifest';
import type { InstalledPacksRoot, WorkflowSourceRoots } from './roots';
import { isDirectory } from './tree';
import { getLog } from './log';

/**
 * Load a capture and prove its bytes are the ones that were frozen.
 *
 * Throws {@link WorkflowSourceUnavailableError} for missing or inaccessible source,
 * including the manifest, so an admitted run can resume on a readable host.
 * Throws {@link WorkflowSourceIntegrityError} for a malformed manifest, an unsupported
 * shape, or a digest or resolution-settings mismatch; these invalidate the frozen source.
 * Other I/O errors propagate unchanged.
 */
export async function loadWorkflowSource(
  captureRoot: string,
  /**
   * The digest the RUN recorded, when the caller has it.
   *
   * Without this, verification is circular: the manifest is inside the capture, so
   * replacing the whole directory — files and manifest together — with a different but
   * internally consistent capture passes every check. The run row holds the digest
   * out-of-band, and comparing against it is what closes that.
   */
  expectedDigest?: string,
  /** The source resolution config the RUN recorded, when new enough to have one. */
  expectedConfig?: WorkflowSourceConfig
): Promise<WorkflowSourceCapture & { verifiedFiles: ReadonlySet<string> }> {
  const manifest = await readManifest(captureRoot);
  if (expectedDigest !== undefined && manifest.digest !== expectedDigest) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} is not the one this run recorded ` +
        `(run expects ${expectedDigest.slice(0, 12)}…, capture claims ` +
        `${manifest.digest.slice(0, 12)}…). The capture has been replaced.`,
      captureRoot
    );
  }
  if (
    expectedConfig !== undefined &&
    !isDeepStrictEqual(
      definedSourceConfig(manifest.source_config),
      definedSourceConfig(expectedConfig)
    )
  ) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} has different resolution settings than this ` +
        'run recorded. The capture manifest has changed.',
      captureRoot
    );
  }
  let entries: DigestEntry[];
  try {
    entries = await digestEntries(captureRoot);
  } catch (error) {
    throw sourceReadError(captureRoot, error);
  }
  const digest = foldDigest(entries);
  if (digest !== manifest.digest) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} does not match its recorded digest ` +
        `(expected ${manifest.digest.slice(0, 12)}…, found ${digest.slice(0, 12)}…). ` +
        'The captured source has changed since the run started.',
      captureRoot
    );
  }
  if (manifest.engine_version !== BUNDLED_VERSION) {
    // Recorded, never enforced: the verified captured bytes remain authoritative across
    // an upgrade; the version is provenance for diagnostics, not source identity.
    getLog().warn(
      { captureRoot, capturedBy: manifest.engine_version, runningOn: BUNDLED_VERSION },
      'workflow.source_engine_version_changed'
    );
  }
  return {
    verifiedFiles: new Set(entries.map(entry => join(captureRoot, entry.relPath))),
    origin: manifest.origin,
    manifest,
    anchor: {
      root: captureRoot,
      digest: expectedDigest ?? manifest.digest,
      config: expectedConfig ?? manifest.source_config,
    },
  };
}

function definedSourceConfig(config: WorkflowSourceConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

/** Returned paths are files covered by the verified digest; live roots have no inventory. */
export async function assertWorkflowSourceIntegrity(
  roots: WorkflowSourceRoots
): Promise<ReadonlySet<string> | undefined> {
  if (roots.kind === 'live') return;
  const capture = await loadWorkflowSource(
    roots.anchor.root,
    roots.anchor.digest,
    roots.anchor.config
  );
  return capture.verifiedFiles;
}

/**
 * The verified capture a run recorded at start, manifest included.
 *
 * Returns the CAPTURE rather than its path because every caller needs the manifest too —
 * its `source_config` decides how those bytes resolve, and a caller handed only the path
 * rebuilt the roots from defaults, which is how a resume re-discovered a different DAG.
 *
 * Throws {@link WorkflowSourceIntegrityError} when the run HAS a record but the capture
 * cannot be verified. Returns `undefined` only when the run has no record at all — a run
 * created before captures existed, which resumes against live source because its original
 * bytes were never stored and cannot be reconstructed.
 */
export async function resolveRunSourceCapture(
  metadata: Record<string, unknown> | undefined
): Promise<WorkflowSourceCapture | undefined> {
  const state = readWorkflowSourceState(metadata);
  if (state.kind === 'unreadable') {
    // NOT the same as having no record. This run recorded something; we simply cannot
    // read it. Resolving live here would execute source the run never agreed to.
    const recordedPath = workflowSourceMetadataSchema
      .pick({ root: true })
      .safeParse(metadata?.[WORKFLOW_SOURCE_METADATA_KEY]);
    throw new WorkflowSourceIntegrityError(
      `This run's workflow source record cannot be read by this build: ${state.detail}`,
      recordedPath.success ? recordedPath.data.root : undefined
    );
  }
  if (state.kind === 'absent') return undefined;
  const capture = await loadWorkflowSource(
    state.record.root,
    state.record.digest,
    state.record.source_config
  );
  if (state.record.source_config === undefined) {
    getLog().warn(
      {
        captureRoot: state.record.root,
        warning:
          'This pre-change run did not record source resolution settings outside its capture. ' +
          'The manifest settings are used for this read; a resume pins them on the run row.',
      },
      'workflow.source_config_legacy_manifest_anchor'
    );
  }
  return capture;
}

/**
 * The installed packs a not-yet-started `workflow:` child reads: its parent's verified
 * capture, so the child cannot run a pack at a different revision from its parent after
 * `archon plugin update` or `remove`. Undefined for a parent with no source record,
 * which reads the live installs. Unlike project source (see
 * {@link resolveChildDiscoveryRoot}), there is no mid-run authoring to pick up here: an
 * installed pack changes only through the installer.
 */
export async function resolveChildInstalledPacks(
  metadata: Record<string, unknown> | undefined
): Promise<InstalledPacksRoot | undefined> {
  const capture = await resolveRunSourceCapture(metadata);
  return capture ? { kind: 'captured', captureRoot: capture.anchor.root } : undefined;
}

/**
 * The AUTHORING directory a run was captured from.
 *
 * Deliberately different from {@link resolveRunSourceCapture}, and the difference is the
 * whole contract for sub-runs: a run freezes its own source, but a `workflow:` child that
 * has not started yet is not a run, so it must not be frozen into its parent.
 *
 * Two behaviors depend on reading the live origin here rather than the parent's capture:
 * a parent may author a workflow mid-flight and then execute it as a child, and a failed
 * fan-out child is recovered by fixing the child workflow and resuming the parent, which
 * re-drives that child. Resolving it from the parent's frozen copy would re-drive the OLD
 * broken definition forever, so the fix could never take. The child's own run captures at its own start, which is where its
 * determinism begins.
 *
 * Returns `undefined` only for a historical parent with no source record. Once a parent
 * records an authoring directory, an unreadable record or unavailable directory fails
 * closed so a child cannot silently capture a same-named workflow from the target cwd.
 */
export async function resolveChildDiscoveryRoot(
  metadata: Record<string, unknown> | undefined
): Promise<string | undefined> {
  const state = readWorkflowSourceState(metadata);
  if (state.kind === 'absent') return undefined;
  if (state.kind === 'unreadable') {
    throw new WorkflowSourceIntegrityError(
      `This run's workflow source record cannot be read by this build: ${state.detail}`
    );
  }
  if (!(await isDirectory(state.record.origin))) {
    throw new WorkflowSourceIntegrityError(
      `This run's recorded authoring source is unavailable at ${state.record.origin}. ` +
        'A child workflow cannot start from a different checkout.'
    );
  }
  return state.record.origin;
}
