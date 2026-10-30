import { openWorkflowSource, assertWorkflowSourceIntegrity, sourceDirectoryHasFiles } from './load';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import {
  describeIssues,
  PLUGIN_MANIFEST_FILE,
  workflowPackManifestSchema,
  type WorkflowPackManifest,
} from '@archon/plugin-manifest';
import { packTreePath, scanReceipts } from '@archon/plugin-manifest/store';
import type { WorkflowResourceOwner } from '../packaged-workflow';
import {
  INSTALLED_SCOPE_DIR,
  sourceUnitForOwner,
  type InstalledPacksRoot,
  type WorkflowSourceRoots,
} from './roots';

export {
  installedPackKey,
  installedPluginRecordSchema,
  installedWorkflowName,
  type InstalledPluginRecord,
} from './installed-record';
import {
  installedPackKey,
  installedWorkflowName,
  type InstalledPluginRecord,
} from './installed-record';
import { verifyIndexedUnits } from './verify-units';

/** One installed workflow pack, read from receipts (live) or from a capture. */
export interface InstalledPack {
  /** The install id's owner: the `owner` of `owner/plugin:entrypoint`. */
  readonly owner: string;
  /** The manifest `name`: the `plugin` of `owner/plugin:entrypoint`. */
  readonly name: string;
  /**
   * `<owner>.<name>`, unique per install because the installer refuses a second pack
   * with the same owner and name. Neither part can contain `.`, so it splits back
   * unambiguously. It is the pack segment of the pack's resource references and the
   * pack's directory in a capture.
   */
  readonly key: string;
  /** The pack root, holding `archon-plugin.json`. */
  readonly dir: string;
  /** Live tree manifest or the captured, run-authenticated descriptor. */
  readonly manifest: WorkflowPackManifest;
  /** Present for a live pack; a capture's manifest keeps the records of its packs. */
  readonly record?: InstalledPluginRecord;
}

export async function readPackManifest(dir: string): Promise<WorkflowPackManifest> {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf-8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = workflowPackManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** A pack that could not be listed, with the entrypoint it takes down when known. */
export interface InstalledPackListError {
  path: string;
  message: string;
  cause?: unknown;
  workflowName?: string;
}

/**
 * Live install faults are catalog errors. Captured lookups verify the requested packs
 * and throw typed source errors, so frozen bytes cannot be replaced by a live install.
 */
export async function listInstalledPacks(
  root: InstalledPacksRoot,
  keys?: ReadonlySet<string>
): Promise<{ packs: InstalledPack[]; errors: InstalledPackListError[] }> {
  if (root.kind === 'captured') {
    const capture = await openWorkflowSource(
      root.anchor.root,
      root.anchor.digest,
      root.anchor.config
    );
    if (capture.manifest.version === 3) {
      const records = capture.manifest.installed_plugins.filter(
        record => keys === undefined || keys.has(record.key)
      );
      await verifyIndexedUnits(
        root.anchor.root,
        capture.manifest,
        records.map(record => `installed/${record.key}`)
      );
      return {
        packs: records.map(record => ({
          owner: record.id.split('/')[0],
          name: record.manifest.name,
          key: record.key,
          dir: join(root.anchor.root, INSTALLED_SCOPE_DIR, record.key),
          manifest: record.manifest,
          record,
        })),
        errors: [],
      };
    }
  }
  return root.kind === 'receipts'
    ? listReceiptPacks(root.pluginsDir)
    : listCapturedPacks(root.anchor.root, keys);
}

async function listReceiptPacks(
  pluginsDir: string
): Promise<{ packs: InstalledPack[]; errors: InstalledPackListError[] }> {
  const packs: InstalledPack[] = [];
  const errors: InstalledPackListError[] = [];
  let scan: Awaited<ReturnType<typeof scanReceipts>>;
  try {
    scan = await scanReceipts(pluginsDir);
  } catch (error) {
    errors.push({ path: pluginsDir, message: (error as Error).message, cause: error });
    return { packs, errors };
  }
  errors.push(
    ...scan.broken
      .filter(entry => !entry.unavailableReason)
      .map(entry => ({
        path: entry.file,
        message: entry.message,
        cause: entry.cause,
      }))
  );
  for (const receipt of scan.receipts) {
    if (receipt.manifest.kind !== 'workflow-pack') continue;
    const owner = receipt.id.split('/')[0];
    const dir = packTreePath(pluginsDir, receipt.id, receipt.commit);
    try {
      const manifest = await readPackManifest(dir);
      const key = installedPackKey(owner, manifest.name);
      packs.push({
        owner,
        name: manifest.name,
        key,
        dir,
        manifest,
        record: {
          key,
          id: receipt.id,
          commit: receipt.commit,
          ...(receipt.tag !== undefined ? { tag: receipt.tag } : {}),
        },
      });
    } catch (error) {
      for (const entry of Object.keys(receipt.manifest.entrypoints)) {
        errors.push({
          path: dir,
          workflowName: installedWorkflowName({ owner, name: receipt.manifest.name }, entry),
          message: (error as Error).message,
          cause: error,
        });
      }
    }
  }
  return { packs, errors };
}

async function listCapturedPacks(
  captureRoot: string,
  selectedKeys?: ReadonlySet<string>
): Promise<{ packs: InstalledPack[]; errors: InstalledPackListError[] }> {
  const packs: InstalledPack[] = [];
  const errors: InstalledPackListError[] = [];
  const installedDir = join(captureRoot, INSTALLED_SCOPE_DIR);
  let keys: string[];
  try {
    keys = await readdir(installedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { packs, errors };
    throw error;
  }
  for (const key of keys.sort()) {
    if (selectedKeys !== undefined && !selectedKeys.has(key)) continue;
    const dir = join(installedDir, key);
    const separator = key.indexOf('.');
    try {
      const manifest = await readPackManifest(dir);
      if (separator < 1 || key.slice(separator + 1) !== manifest.name) {
        throw new Error(`Captured pack ${key} does not match its manifest name ${manifest.name}`);
      }
      packs.push({ owner: key.slice(0, separator), name: manifest.name, key, dir, manifest });
    } catch (error) {
      errors.push({ path: dir, message: (error as Error).message, cause: error });
    }
  }
  return { packs, errors };
}

/**
 * The directory of one packaged workflow (`<pack>/<workflow>/`) under `roots`, or null
 * when its scope has no source here. Command, script and validation lookups all map a
 * resource owner to disk through this, so a new scope is added in one place.
 */
export async function packagedWorkflowDirectory(
  roots: WorkflowSourceRoots,
  owner: WorkflowResourceOwner
): Promise<string | null> {
  const verifiedFiles = await assertWorkflowSourceIntegrity(roots, {
    units: [sourceUnitForOwner(owner)],
  });
  const available = (directory: string) =>
    sourceDirectoryHasFiles(verifiedFiles, directory) ? directory : null;
  switch (owner.source) {
    case 'project':
      return roots.project === null
        ? null
        : available(join(roots.project, '.archon', 'workflows', owner.pack, owner.workflow));
    case 'global':
      return available(join(roots.globalWorkflows, owner.pack, owner.workflow));
    case 'bundled':
      return available(join(roots.bundledWorkflows, owner.pack, owner.workflow));
    case 'installed': {
      const { packs, errors } = await listInstalledPacks(roots.installed, new Set([owner.pack]));
      if (roots.installed.kind === 'captured') {
        const packPath = join(roots.installed.anchor.root, INSTALLED_SCOPE_DIR, owner.pack);
        const failure = errors.find(error => error.path === packPath);
        if (failure) throw failure.cause ?? new Error(failure.message);
      }
      const pack = packs.find(p => p.key === owner.pack);
      return pack ? join(pack.dir, owner.workflow) : null;
    }
  }
}
