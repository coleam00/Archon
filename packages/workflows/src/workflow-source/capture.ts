import { mkdir, rename, rm } from 'fs/promises';
import { dirname, join } from 'path';
import * as archonPaths from '@archon/paths';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import type { WorkflowSourceConfig } from '../schemas/workflow-run';
import { resolveBundledScope, writeBundledScope } from './bundled-scope';
import { listInstalledPacks } from './installed-packs';
import { WorkflowSourceUnavailableError } from './integrity';
import {
  digestEntries,
  indexedSourceDigest,
  workflowSourceManifestSchema,
  type IndexedWorkflowSourceManifest,
  readManifest,
  writeManifest,
  type WorkflowSourceCapture,
  type WorkflowSourceManifest,
} from './manifest';
import {
  BUNDLED_SCOPE_DIR,
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
  GLOBAL_SCOPE_DIR,
  INSTALLED_SCOPE_DIR,
  PROJECT_SCOPE_DIR,
  liveSourceRoots,
  type InstalledPacksRoot,
} from './roots';
import { copyListing, isDirectory, listTree, projectSourceDirs } from './tree';
import { getLog } from './log';
import type { IndexedInstalledPlugin, SourceUnit } from './unit-index';

/**
 * Soft ceiling on a capture, in bytes. Exceeding it is NOT an error — a repo is
 * allowed a large scripts tree, and failing the run over it would be worse than the
 * cost. It logs once so an author who accidentally parks a dataset in
 * `.archon/scripts/` finds out from the run rather than from their disk.
 */
const CAPTURE_WARN_BYTES = 64 * 1024 * 1024;

type CapturedScope = 'project' | 'global' | 'bundled' | 'installed';

/** One MUTABLE directory worth copying: its capture-relative destination and its origin. */
interface CaptureJob {
  dest: string;
  from: string;
  scope: Exclude<CapturedScope, 'bundled'>;
}

/** The installed packs a capture copies, and what its manifest records about them. */
interface InstalledCapture {
  jobs: CaptureJob[];
  records: IndexedInstalledPlugin[];
  unavailableWorkflows: string[];
}

/**
 * Freeze `sourceRoot`'s executable source, plus every other statically reachable scope,
 * into `captureRoot`.
 *
 * Throws on failure. A capture is the run's only executable source, so a caller that
 * cannot take one must fail the run rather than proceed against live files.
 *
 * The capture is built in a sibling `.partial` directory and renamed into place, so a
 * failure part-way through can never leave a half-populated capture that later reads
 * would treat as authoritative.
 */
export async function captureWorkflowSource(opts: {
  sourceRoot: string;
  captureRoot: string;
  commandFolder?: string;
  sourceConfig?: WorkflowSourceConfig;
  /**
   * Where installed packs are copied from. Omitted, the live installs. A `workflow:`
   * child passes its parent's capture, so a pack updated or removed after the parent
   * started cannot give the child a different revision from its parent.
   */
  installedFrom?: InstalledPacksRoot;
}): Promise<WorkflowSourceCapture> {
  const {
    sourceRoot,
    captureRoot,
    commandFolder,
    sourceConfig = DEFAULT_WORKFLOW_SOURCE_CONFIG,
  } = opts;

  // The bundled scope is not among the jobs: it is this build's own, read once into a
  // {@link BundledScope} and written from there.
  const jobs = await mutableScopeJobs(sourceRoot, commandFolder);
  const installed = await installedCapture(
    opts.installedFrom ?? liveSourceRoots(sourceRoot).installed
  );
  jobs.push(...installed.jobs);

  const staging = `${captureRoot}.partial`;
  await rm(staging, { recursive: true, force: true });
  try {
    const manifest = await stageCapture(staging, jobs, installed, {
      origin: sourceRoot,
      sourceConfig,
    });

    // Replace rather than merge: a stale capture at this path would silently mix two
    // vintages of source, which is the failure this module exists to prevent.
    await rm(captureRoot, { recursive: true, force: true });
    await mkdir(dirname(captureRoot), { recursive: true });
    await rename(staging, captureRoot);

    logCaptured(sourceRoot, captureRoot, manifest);
    return {
      origin: sourceRoot,
      manifest,
      anchor: { root: captureRoot, digest: manifest.digest, config: manifest.source_config },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      /* best-effort: the partial directory is inert, and the original error matters more */
    });
    throw error;
  }
}

/** The project and global source directories that exist. */
async function mutableScopeJobs(
  sourceRoot: string,
  commandFolder: string | undefined
): Promise<CaptureJob[]> {
  const jobs: CaptureJob[] = [];
  for (const dir of projectSourceDirs(commandFolder)) {
    const from = join(sourceRoot, dir);
    if (await isDirectory(from))
      jobs.push({ dest: join(PROJECT_SCOPE_DIR, dir), from, scope: 'project' });
  }
  for (const [name, from] of [
    ['workflows', archonPaths.getHomeWorkflowsPath()],
    ['commands', archonPaths.getHomeCommandsPath()],
    ['scripts', archonPaths.getHomeScriptsPath()],
  ] as const) {
    if (await isDirectory(from))
      jobs.push({ dest: join(GLOBAL_SCOPE_DIR, name), from, scope: 'global' });
  }
  return jobs;
}

async function installedCapture(installedFrom: InstalledPacksRoot): Promise<InstalledCapture> {
  const { packs, errors } = await listInstalledPacks(installedFrom);
  const jobs: CaptureJob[] = packs.map(pack => ({
    dest: join(INSTALLED_SCOPE_DIR, pack.key),
    from: pack.dir,
    scope: 'installed',
  }));
  if (installedFrom.kind === 'receipts') {
    return {
      jobs,
      records: packs.flatMap(pack =>
        pack.record ? [{ ...pack.record, manifest: pack.manifest }] : []
      ),
      unavailableWorkflows: errors.flatMap(error =>
        error.workflowName ? [error.workflowName] : []
      ),
    };
  }

  // A child copies its parent's frozen packs; one it cannot read is this host's fault.
  if (errors.length > 0) throw errors[0].cause ?? new Error(errors[0].message);
  const parent = await readManifest(installedFrom.captureRoot);
  const keys = new Set(packs.map(pack => pack.key));
  const records = parent.version !== 1 ? parent.installed_plugins : [];
  for (const record of records) {
    if (!keys.has(record.key)) {
      throw new WorkflowSourceUnavailableError(
        join(installedFrom.captureRoot, INSTALLED_SCOPE_DIR, record.key),
        new Error('Installed pack recorded by the parent capture could not be listed')
      );
    }
  }
  const indexedRecords = records.map(record => {
    const pack = packs.find(pack => pack.key === record.key);
    if (!pack) throw new Error(`Missing captured pack: ${record.key}`);
    return { ...record, manifest: pack.manifest };
  });
  return {
    jobs,
    records: indexedRecords,
    unavailableWorkflows: parent.unavailable_installed_workflows ?? [],
  };
}

/** Populate `staging` and write its manifest. */
async function stageCapture(
  staging: string,
  jobs: readonly CaptureJob[],
  installed: InstalledCapture,
  source: { origin: string; sourceConfig: WorkflowSourceConfig }
): Promise<WorkflowSourceManifest> {
  const scopesCaptured = new Set<CapturedScope>(jobs.map(j => j.scope));
  await mkdir(staging, { recursive: true });
  for (const job of jobs) {
    const target = join(staging, job.dest);
    await mkdir(dirname(target), { recursive: true });
    await copyListing(await listTree(job.from), target);
  }

  // The run's own bundled bytes, written from what this process already holds. They have
  // to be present, not referenced: that is what lets a run that statically included a
  // bundled workflow prove on resume that it did not change under an Archon upgrade.
  const bundled = await resolveBundledScope();
  if (bundled) {
    await writeBundledScope(bundled, staging);
    scopesCaptured.add('bundled');
  }

  // The bundled files were written from bytes whose hashes are already known, so reading
  // them back would restate what the scope already carries. Everything else is read.
  const entries = await digestEntries(staging, bundled ? BUNDLED_SCOPE_DIR : undefined);
  const allEntries = [...entries, ...(bundled?.files ?? [])];
  const unitRoots = [
    ...[...scopesCaptured].filter(scope => scope !== 'installed'),
    ...installed.records.map(record => `installed/${record.key}`),
  ].sort();
  const units: SourceUnit[] = unitRoots.map(root => ({
    root,
    files: allEntries
      .map(entry => ({ ...entry, relPath: entry.relPath.split('\\').join('/') }))
      .filter(entry => entry.relPath.startsWith(`${root}/`))
      .map(entry => ({
        path: entry.relPath.slice(root.length + 1),
        hash: entry.hash,
        size: entry.size,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }));
  const manifest: IndexedWorkflowSourceManifest = {
    engine_version: BUNDLED_VERSION,
    origin: source.origin,
    captured_at: new Date().toISOString(),
    version: 3,
    units,
    installed_plugins: installed.records,
    digest: '0'.repeat(64),
    file_count: allEntries.length,
    byte_count: allEntries.reduce((sum, entry) => sum + entry.size, 0),
    scopes: [...scopesCaptured],
    source_config: source.sourceConfig,
    ...(installed.unavailableWorkflows.length > 0
      ? { unavailable_installed_workflows: installed.unavailableWorkflows }
      : {}),
  };
  manifest.digest = indexedSourceDigest(manifest);
  workflowSourceManifestSchema.parse(manifest);
  await writeManifest(staging, manifest);
  return manifest;
}

function logCaptured(
  sourceRoot: string,
  captureRoot: string,
  manifest: WorkflowSourceManifest
): void {
  const { file_count: fileCount, byte_count: byteCount } = manifest;
  if (byteCount > CAPTURE_WARN_BYTES) {
    getLog().warn(
      { sourceRoot, captureRoot, fileCount, byteCount, limitBytes: CAPTURE_WARN_BYTES },
      'workflow.source_capture_large'
    );
  }
  getLog().debug(
    { sourceRoot, captureRoot, fileCount, byteCount, scopes: manifest.scopes },
    'workflow.source_captured'
  );
}

/**
 * Stamp the selected workflow onto an existing capture.
 *
 * Selection happens after the capture because discovery must read the frozen bytes, not
 * whatever is on disk a moment later. Only the diagnostic workflow_name stamp is
 * excluded from the v3 header commitment; changing it leaves the capture identity intact.
 */
export async function recordSelectedWorkflow(
  captureRoot: string,
  workflowName: string
): Promise<void> {
  const manifest = await readManifest(captureRoot);
  await writeManifest(captureRoot, { ...manifest, workflow_name: workflowName });
}
