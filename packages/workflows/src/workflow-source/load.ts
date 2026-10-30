import { commandNameForRelativePath, getCommandFolderSearchPaths } from '@archon/paths';
import { getRuntimeForExtension, MAX_SCRIPT_DISCOVERY_DEPTH } from '../script-file';
import { installedWorkflowName } from './installed-record';
import { parsePackagedResourceReference } from '../packaged-workflow';
import { isDeepStrictEqual } from 'node:util';
import { basename, extname, join, relative, sep } from 'path';
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
  indexedSourceDigest,
  readManifest,
  type DigestEntry,
  type WorkflowSourceCapture,
  type WorkflowSourceManifest,
  type IndexedWorkflowSourceManifest,
} from './manifest';
import {
  installedSourceUnit,
  sourceUnitForOwner,
  PROJECT_SCOPE_DIR,
  GLOBAL_SCOPE_DIR,
  BUNDLED_SCOPE_DIR,
  type InstalledPacksRoot,
  type WorkflowSourceRoots,
  type WorkflowSourceAnchor,
} from './roots';
import { isDirectory } from './tree';
import { getLog } from './log';
import { assertIndexedLayout, verifyIndexedUnits } from './verify-units';

type SourceVerification =
  | { manifest: IndexedWorkflowSourceManifest; verifiedFiles: undefined }
  | {
      manifest: Exclude<WorkflowSourceManifest, IndexedWorkflowSourceManifest>;
      verifiedFiles: ReadonlySet<string>;
    };
type OpenedWorkflowSource = WorkflowSourceCapture & SourceVerification;

/**
 * Authenticate a capture's index without certifying v3 payload bytes.
 * Legacy formats have no independent index and require full aggregate verification.
 *
 * Throws {@link WorkflowSourceUnavailableError} for missing or inaccessible source,
 * including the manifest, so an admitted run can resume on a readable host.
 * Throws {@link WorkflowSourceIntegrityError} for a malformed manifest, an unsupported
 * shape, or a digest or resolution-settings mismatch; these invalidate the frozen source.
 * Other I/O errors propagate unchanged.
 */
export async function openWorkflowSource(
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
): Promise<OpenedWorkflowSource> {
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
  let verification: SourceVerification;
  if (manifest.version === 3) {
    if (indexedSourceDigest(manifest) !== manifest.digest) {
      throw new WorkflowSourceIntegrityError(
        `Workflow source index at ${captureRoot} does not match its recorded digest`,
        captureRoot
      );
    }
    verification = { manifest, verifiedFiles: undefined };
  } else {
    verification = {
      manifest,
      verifiedFiles: await verifyLegacyCapture(captureRoot, manifest.digest),
    };
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
    ...verification,
    origin: manifest.origin,
    anchor: {
      root: captureRoot,
      digest: expectedDigest ?? manifest.digest,
      config: expectedConfig ?? manifest.source_config,
    },
  };
}

async function verifyLegacyCapture(
  captureRoot: string,
  expectedDigest: string
): Promise<ReadonlySet<string>> {
  let entries: DigestEntry[];
  try {
    entries = await digestEntries(captureRoot);
  } catch (error) {
    const failure = sourceReadError(captureRoot, error);
    if (failure instanceof Error) {
      failure.message +=
        ' Legacy v1/v2 captures require the entire aggregate; an unrelated pack read fault cannot be isolated.';
    }
    throw failure;
  }
  const digest = foldDigest(entries);
  if (digest !== expectedDigest) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} does not match its recorded digest ` +
        `(expected ${expectedDigest.slice(0, 12)}…, found ${digest.slice(0, 12)}…). ` +
        'The captured source has changed since the run started.',
      captureRoot
    );
  }
  return new Set(entries.map(entry => join(captureRoot, entry.relPath)));
}

/** Full verification of all payloads, including the legacy aggregate formats. */
export async function loadWorkflowSource(
  captureRoot: string,
  expectedDigest?: string,
  expectedConfig?: WorkflowSourceConfig
): Promise<WorkflowSourceCapture & { verifiedFiles: ReadonlySet<string> }> {
  const capture = await openWorkflowSource(captureRoot, expectedDigest, expectedConfig);
  if (capture.verifiedFiles !== undefined)
    return { ...capture, verifiedFiles: capture.verifiedFiles };
  await assertIndexedLayout(captureRoot, capture.manifest);
  const verifiedFiles = await verifyIndexedUnits(
    captureRoot,
    capture.manifest,
    capture.manifest.units.map(unit => unit.root)
  );
  return { ...capture, verifiedFiles };
}

/** Reauthenticate the run's commitment and verify only the requested v3 units. */
export async function verifyWorkflowSourceUnits(
  anchor: WorkflowSourceAnchor,
  roots: readonly string[]
): Promise<WorkflowSourceCapture & { verifiedFiles: ReadonlySet<string> }> {
  const capture = await openWorkflowSource(anchor.root, anchor.digest, anchor.config);
  if (capture.verifiedFiles !== undefined)
    return { ...capture, verifiedFiles: capture.verifiedFiles };
  const verifiedFiles = await verifyIndexedUnits(anchor.root, capture.manifest, roots);
  return { ...capture, verifiedFiles };
}

function definedSourceConfig(config: WorkflowSourceConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

/** Returned paths are files covered by the verified digest; live roots have no inventory. */
export async function assertWorkflowSourceIntegrity(
  roots: WorkflowSourceRoots,
  read?:
    | { resources: readonly string[]; kind?: 'command' | 'script' }
    | { units: readonly string[] }
): Promise<ReadonlySet<string> | undefined> {
  if (roots.kind === 'live') return;
  if (read !== undefined && 'resources' in read)
    return verifyWorkflowSourceResources(roots, read.resources, read.kind);
  if (read !== undefined) {
    const opened = await openWorkflowSource(
      roots.anchor.root,
      roots.anchor.digest,
      roots.anchor.config
    );
    if (opened.verifiedFiles !== undefined) return opened.verifiedFiles;
    return verifyIndexedUnits(
      roots.anchor.root,
      opened.manifest,
      read.units.filter(root => opened.manifest.units.some(unit => unit.root === root))
    );
  }
  const capture = await verifySelectedWorkflowSource(roots.anchor, roots.workflowName);
  return capture.verifiedFiles;
}

/**
 * Authenticate the capture a run recorded at start. V3 payloads are verified at selection
 * and resource lookup; legacy captures require full aggregate verification here.
 *
 * Returns the CAPTURE rather than its path because every caller needs the manifest too —
 * its `source_config` decides how those bytes resolve, and a caller handed only the path
 * rebuilt the roots from defaults, which is how a resume re-discovered a different DAG.
 *
 * Throws {@link WorkflowSourceIntegrityError} when the run HAS a record but the capture
 * cannot be authenticated. Returns `undefined` only when the run has no record at all — a run
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
  const capture = await openWorkflowSource(
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
 * The installed packs a not-yet-started `workflow:` child reads: its parent's authenticated
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
  return capture ? { kind: 'captured', anchor: capture.anchor } : undefined;
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

/** Resolve shared filename precedence and dependency ownership from the authenticated index. */
export function selectedWorkflowUnits(
  manifest: IndexedWorkflowSourceManifest,
  workflowName: string
): string[] {
  const files = new Map<string, { root: string; name: string; references: string[] }>();
  for (const scope of [BUNDLED_SCOPE_DIR, GLOBAL_SCOPE_DIR, PROJECT_SCOPE_DIR]) {
    if (scope === BUNDLED_SCOPE_DIR && !manifest.source_config.load_default_workflows) continue;
    for (const file of manifest.units.find(unit => unit.root === scope)?.files ?? []) {
      if (file.workflow !== undefined)
        files.set(basename(file.path), { root: scope, ...file.workflow });
    }
  }
  const selected = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const entrypoint = manifest.installed_plugins.find(record =>
      Object.keys(record.manifest.entrypoints).some(
        entry =>
          name ===
          installedWorkflowName(
            { owner: record.id.split('/')[0], name: record.manifest.name },
            entry
          )
      )
    );
    if (entrypoint !== undefined) {
      selected.add(installedSourceUnit(entrypoint.key));
      return;
    }
    const shared = [...files.values()].filter(file => file.name === name);
    if (shared.length > 0) {
      for (const file of shared) {
        selected.add(file.root);
        for (const reference of file.references) visit(reference);
      }
      return;
    }
    for (const record of manifest.installed_plugins) {
      const root = installedSourceUnit(record.key);
      const entrypointPaths = new Set(Object.values(record.manifest.entrypoints));
      if (
        manifest.units
          .find(unit => unit.root === root)
          ?.files.some(
            file =>
              file.workflow !== undefined &&
              !entrypointPaths.has(file.path) &&
              name ===
                installedWorkflowName(
                  { owner: record.id.split('/')[0], name: record.manifest.name },
                  file.workflow.name
                )
          )
      )
        selected.add(root);
    }
  };
  visit(workflowName);
  return [...selected];
}

export async function verifySelectedWorkflowSource(
  anchor: WorkflowSourceAnchor,
  workflowName?: string
) {
  if (workflowName === undefined)
    return loadWorkflowSource(anchor.root, anchor.digest, anchor.config);
  const capture = await openWorkflowSource(anchor.root, anchor.digest, anchor.config);
  if (capture.verifiedFiles !== undefined)
    return { ...capture, verifiedFiles: capture.verifiedFiles };
  const verifiedFiles = await verifyIndexedUnits(
    anchor.root,
    capture.manifest,
    selectedWorkflowUnits(capture.manifest, workflowName)
  );
  return { ...capture, verifiedFiles };
}

/** A resource lookup verifies its actual owners, after runtime substitution. */
export async function verifyWorkflowSourceResources(
  roots: WorkflowSourceRoots,
  names?: readonly string[],
  kind: 'command' | 'script' = 'command'
): Promise<ReadonlySet<string> | undefined> {
  if (roots.kind === 'live') return;
  if (names === undefined)
    return (await loadWorkflowSource(roots.anchor.root, roots.anchor.digest, roots.anchor.config))
      .verifiedFiles;
  const capture = await openWorkflowSource(
    roots.anchor.root,
    roots.anchor.digest,
    roots.anchor.config
  );
  if (capture.verifiedFiles !== undefined) return capture.verifiedFiles;
  const requested = names.flatMap(name => {
    const reference = parsePackagedResourceReference(name);
    if (reference === null) return sharedResourceUnits(roots, capture.manifest, name, kind);
    return [sourceUnitForOwner(reference.owner)];
  });
  const available = new Set(capture.manifest.units.map(unit => unit.root));
  return verifyIndexedUnits(
    roots.anchor.root,
    capture.manifest,
    requested.filter(root => available.has(root))
  );
}

function sharedResourceUnits(
  roots: Extract<WorkflowSourceRoots, { kind: 'captured' }>,
  manifest: IndexedWorkflowSourceManifest,
  name: string,
  kind: 'command' | 'script'
): string[] {
  const project = roots.project;
  const projectDirectories =
    project === null
      ? []
      : (kind === 'script'
          ? ['.archon/scripts']
          : getCommandFolderSearchPaths(manifest.source_config.command_folder)
        ).map(folder => join(project, folder));
  const scopes = [
    { root: PROJECT_SCOPE_DIR, directories: projectDirectories },
    {
      root: GLOBAL_SCOPE_DIR,
      directories: [kind === 'script' ? roots.globalScripts : roots.globalCommands],
    },
    ...(kind === 'command' && manifest.source_config.load_default_commands
      ? [{ root: BUNDLED_SCOPE_DIR, directories: [roots.bundledCommands] }]
      : []),
  ];
  for (const scope of scopes) {
    const unit = manifest.units.find(unit => unit.root === scope.root);
    if (
      unit?.files.some(file =>
        scope.directories.some(directory => {
          const path = relative(directory, join(roots.anchor.root, unit.root, file.path));
          const segments = path.split(sep);
          if (
            segments.some(segment => segment === '..') ||
            (kind === 'script' && segments.length > MAX_SCRIPT_DISCOVERY_DEPTH + 1)
          )
            return false;
          if (kind === 'command') return commandNameForRelativePath(path) === name;
          const extension = extname(path);
          return (
            basename(path, extension) === name && getRuntimeForExtension(extension) !== undefined
          );
        })
      )
    )
      return [scope.root];
  }
  return [];
}

/** Empty or absent scopes have no readable resources; never inspect injected directories. */
export function sourceDirectoryHasFiles(
  files: ReadonlySet<string> | undefined,
  directory: string
): boolean {
  return files === undefined || [...files].some(file => file.startsWith(`${directory}${sep}`));
}
