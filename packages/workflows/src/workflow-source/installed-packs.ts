import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import {
  describeIssues,
  PLUGIN_MANIFEST_FILE,
  workflowPackManifestSchema,
  type WorkflowPackManifest,
} from '@archon/plugin-manifest';
import { packTreePath, scanReceipts } from '@archon/plugin-manifest/store';
import type { WorkflowResourceOwner } from '../packaged-workflow';
import { INSTALLED_SCOPE_DIR, type InstalledPacksRoot, type WorkflowSourceRoots } from './roots';

/** Where an installed pack came from, as its receipt recorded it. */
export const installedPluginRecordSchema = z.object({
  /** {@link InstalledPack.key}: the pack's directory in a capture. */
  key: z.string(),
  /** `owner/repo[/path]` */
  id: z.string(),
  commit: z.string(),
  tag: z.string().optional(),
});

export type InstalledPluginRecord = z.infer<typeof installedPluginRecordSchema>;

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
  /** Read from the tree itself, so a capture and a live listing agree on entrypoints. */
  readonly manifest: WorkflowPackManifest;
  /** Present for a live pack; a capture's manifest keeps the records of its packs. */
  readonly record?: InstalledPluginRecord;
}

export function installedPackKey(owner: string, name: string): string {
  return `${owner}.${name}`;
}

/** The public name of a workflow in an installed pack: `owner/plugin:<name>`. */
export function installedWorkflowName(
  pack: Pick<InstalledPack, 'owner' | 'name'>,
  name: string
): string {
  return `${pack.owner}/${pack.name}:${name}`;
}

async function readPackManifest(dir: string): Promise<WorkflowPackManifest> {
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
 * Every installed workflow pack under `roots`. A pack that cannot be read is reported,
 * not thrown: one broken install must not take the rest of the catalog down with it.
 */
export async function listInstalledPacks(
  root: InstalledPacksRoot
): Promise<{ packs: InstalledPack[]; errors: InstalledPackListError[] }> {
  return root.kind === 'receipts'
    ? listReceiptPacks(root.pluginsDir)
    : listCapturedPacks(root.captureRoot);
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
    ...scan.broken.map(entry => ({
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
  captureRoot: string
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
  switch (owner.source) {
    case 'project':
      return roots.project === null
        ? null
        : join(roots.project, '.archon', 'workflows', owner.pack, owner.workflow);
    case 'global':
      return join(roots.globalWorkflows, owner.pack, owner.workflow);
    case 'bundled':
      return join(roots.bundledWorkflows, owner.pack, owner.workflow);
    case 'installed': {
      const { packs, errors } = await listInstalledPacks(roots.installed);
      if (roots.installed.kind === 'captured') {
        const packPath = join(roots.installed.captureRoot, INSTALLED_SCOPE_DIR, owner.pack);
        const failure = errors.find(error => error.path === packPath);
        if (failure) throw failure.cause ?? new Error(failure.message);
      }
      const pack = packs.find(p => p.key === owner.pack);
      return pack ? join(pack.dir, owner.workflow) : null;
    }
  }
}
