import { copyFile, mkdir, rename, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
import * as archonPaths from '@archon/paths';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import type { WorkflowSourceConfig } from '../schemas/workflow-run';
import { resolveBundledScope, writeBundledScope } from './bundled-scope';
import { listInstalledPacks, type InstalledPluginRecord } from './installed-packs';
import { isSystemError, WorkflowSourceUnavailableError } from './integrity';
import {
  digestEntries,
  foldDigest,
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
import { copyListing, isDirectory, listTree, projectSourceDirs, type TreeListing } from './tree';
import { sourcePackFiles } from './source-pack';
import { getLog } from './log';

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
  /** The files to copy, when not the whole tree under `from`. */
  listing?: TreeListing;
}

/** The installed packs a capture copies, and what its manifest records about them. */
interface InstalledCapture {
  jobs: CaptureJob[];
  records: InstalledPluginRecord[];
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
  /** The directory recorded as the authoring origin, when `sourceRoot` is a temporary composition. */
  origin?: string;
  /**
   * Also freeze `sourceRoot/.archon/config.yaml`, under `project/.archon/config.yaml`, so
   * the run reads the project config it started with and the digest covers it.
   */
  includeProjectConfig?: boolean;
}): Promise<WorkflowSourceCapture> {
  const {
    sourceRoot,
    captureRoot,
    commandFolder,
    sourceConfig = DEFAULT_WORKFLOW_SOURCE_CONFIG,
  } = opts;
  const origin = opts.origin ?? sourceRoot;

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
      origin,
      sourceConfig,
      projectConfig: opts.includeProjectConfig ? join(sourceRoot, PROJECT_CONFIG_FILE) : undefined,
    });

    // Replace rather than merge: a stale capture at this path would silently mix two
    // vintages of source, which is the failure this module exists to prevent.
    await rm(captureRoot, { recursive: true, force: true });
    await mkdir(dirname(captureRoot), { recursive: true });
    await rename(staging, captureRoot);

    logCaptured(sourceRoot, captureRoot, manifest);
    return {
      origin,
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

/** The project config, relative to a project root. */
const PROJECT_CONFIG_FILE = join('.archon', 'config.yaml');

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isSystemError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * The project and global source directories that exist. A source that is a pack folder
 * also freezes the pack's files at the capture's project root, manifest included, so the
 * captured roots read it through `sourcePackFolder` exactly as the live source was read.
 */
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
  const packFiles = await sourcePackFiles(sourceRoot);
  if (packFiles !== null) {
    jobs.push({ dest: PROJECT_SCOPE_DIR, from: sourceRoot, scope: 'project', listing: packFiles });
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
      records: packs.flatMap(pack => (pack.record ? [pack.record] : [])),
      unavailableWorkflows: errors.flatMap(error =>
        error.workflowName ? [error.workflowName] : []
      ),
    };
  }

  // A child copies its parent's frozen packs; one it cannot read is this host's fault.
  if (errors.length > 0) throw errors[0].cause ?? new Error(errors[0].message);
  const parent = await readManifest(installedFrom.captureRoot);
  const keys = new Set(packs.map(pack => pack.key));
  const records = parent.version === 2 ? parent.installed_plugins : [];
  for (const record of records) {
    if (!keys.has(record.key)) {
      throw new WorkflowSourceUnavailableError(
        join(installedFrom.captureRoot, INSTALLED_SCOPE_DIR, record.key),
        new Error('Installed pack recorded by the parent capture could not be listed')
      );
    }
  }
  return { jobs, records, unavailableWorkflows: parent.unavailable_installed_workflows ?? [] };
}

/** Populate `staging` and write its manifest. */
async function stageCapture(
  staging: string,
  jobs: readonly CaptureJob[],
  installed: InstalledCapture,
  source: { origin: string; sourceConfig: WorkflowSourceConfig; projectConfig?: string }
): Promise<WorkflowSourceManifest> {
  let fileCount = 0;
  let byteCount = 0;
  const scopesCaptured = new Set<CapturedScope>(jobs.map(j => j.scope));
  // `.env` files left out, reported once each: a pack folder's root listing and a project
  // directory job (a command folder at the root, say) can both list the same file.
  const skippedEnvFiles = new Set<string>();
  await mkdir(staging, { recursive: true });
  for (const job of jobs) {
    const target = join(staging, job.dest);
    await mkdir(dirname(target), { recursive: true });
    const listing = job.listing ?? (await listTree(job.from));
    for (const file of listing.skippedEnvFiles) skippedEnvFiles.add(file.absPath);
    const copied = await copyListing(listing, target);
    fileCount += copied.files;
    byteCount += copied.bytes;
  }
  if (source.projectConfig !== undefined && (await isFile(source.projectConfig))) {
    const target = join(staging, PROJECT_SCOPE_DIR, PROJECT_CONFIG_FILE);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source.projectConfig, target);
    fileCount += 1;
    byteCount += (await stat(target)).size;
    scopesCaptured.add('project');
  }

  // The run's own bundled bytes, written from what this process already holds. They have
  // to be present, not referenced: that is what lets a run that statically included a
  // bundled workflow prove on resume that it did not change under an Archon upgrade.
  const bundled = await resolveBundledScope();
  if (bundled) {
    await writeBundledScope(bundled, staging);
    for (const path of bundled.skippedEnvFiles) skippedEnvFiles.add(path);
    fileCount += bundled.files.length;
    byteCount += bundled.byteCount;
    scopesCaptured.add('bundled');
  }

  for (const path of skippedEnvFiles) {
    getLog().warn({ path }, 'workflow.source_capture_env_skipped');
  }

  // The bundled files were written from bytes whose hashes are already known, so reading
  // them back would restate what the scope already carries. Everything else is read.
  const entries = await digestEntries(staging, bundled ? BUNDLED_SCOPE_DIR : undefined);
  const fields = {
    engine_version: BUNDLED_VERSION,
    origin: source.origin,
    captured_at: new Date().toISOString(),
    digest: foldDigest([...entries, ...(bundled?.files ?? [])]),
    file_count: fileCount,
    byte_count: byteCount,
    scopes: [...scopesCaptured],
    source_config: source.sourceConfig,
    ...(installed.unavailableWorkflows.length > 0
      ? { unavailable_installed_workflows: installed.unavailableWorkflows }
      : {}),
  };
  const manifest: WorkflowSourceManifest =
    installed.records.length > 0
      ? { version: 2, ...fields, installed_plugins: installed.records }
      : { version: 1, ...fields };
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
 * whatever is on disk a moment later. The manifest is excluded from the digest, so
 * rewriting it here cannot invalidate the capture it describes.
 */
export async function recordSelectedWorkflow(
  captureRoot: string,
  workflowName: string
): Promise<void> {
  const manifest = await readManifest(captureRoot);
  await writeManifest(captureRoot, { ...manifest, workflow_name: workflowName });
}
