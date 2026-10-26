import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { nodeArtifactSchema } from './schemas/node-artifact';
import type { ArtifactManifest } from './schemas/terminal-record';

/**
 * A terminal record is one event row; the cap keeps a huge artifacts tree from making
 * that row (and the walk) unbounded.
 */
export const ARTIFACT_MANIFEST_ENTRY_LIMIT = 10_000;
// Dependency and VCS trees are not run output a person inspects, and dominate entry counts.
const EXCLUDED_ARTIFACT_DIRECTORIES = new Set(['node_modules', '.git']);

/**
 * Observe filenames and sidecars only; output contents never enter a terminal record.
 * The inventory is bounded: `node_modules` and `.git` directories are not walked, and the
 * walk stops after `entryLimit` entries. Each bound is recorded as an `unsupported_entry`
 * limitation whose code names it (`excluded_directory`, `entry_limit`).
 */
export async function observeArtifactManifest(
  root: string | null,
  storageRoot?: string,
  runId?: string,
  entryLimit = ARTIFACT_MANIFEST_ENTRY_LIMIT
): Promise<ArtifactManifest> {
  const manifest: ArtifactManifest = { root, files: [], limitations: [] };
  if (root === null) {
    manifest.limitations.push({ path: '', kind: 'root_unavailable' });
    return manifest;
  }
  // Manifest paths are portable wire values; preserve the sidecar's native path.
  function portablePath(path: string): string {
    return path.split(sep).join('/');
  }
  function fault(path: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException).code;
    manifest.limitations.push({
      path: portablePath(path),
      kind: code === 'ENOENT' ? 'missing' : 'unreadable',
      ...(code ? { code } : {}),
    });
  }
  // The operator's storage root may itself use a platform alias (/var on macOS).
  // Reject links below that boundary, including the run directory itself.
  // This remains an observation of a mutable tree, not a filesystem snapshot.
  let scanRoot = root;
  try {
    if (storageRoot !== undefined)
      scanRoot = join(await realpath(storageRoot), relative(storageRoot, root));
    if ((await realpath(scanRoot)) !== resolve(scanRoot)) {
      manifest.limitations.push({ path: '', kind: 'link_excluded' });
      return manifest;
    }
  } catch (error) {
    fault('', error);
    return manifest;
  }
  const metadata: { path: string; value: ReturnType<typeof nodeArtifactSchema.parse> }[] = [];
  let admitted = 0;
  let limitReached = false;
  // Counts every entry, directories included, so a tree of empty directories is bounded too.
  // Records the cap at the first entry it refuses; every level of the recursion then stops.
  function admit(path: string): boolean {
    if (limitReached) return false;
    if (admitted < entryLimit) {
      admitted += 1;
      return true;
    }
    manifest.limitations.push({ path, kind: 'unsupported_entry', code: 'entry_limit' });
    limitReached = true;
    return false;
  }
  async function visit(directory: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      fault(relative(scanRoot, directory), error);
      return;
    }
    for (const name of entries.sort()) {
      const path = portablePath(relative(scanRoot, join(directory, name)));
      if (!admit(path)) return;
      try {
        await observeEntry(directory, name, path);
      } catch (error) {
        fault(path, error);
      }
    }
  }
  async function observeEntry(directory: string, name: string, path: string): Promise<void> {
    const full = join(directory, name);
    const stat = await lstat(full, { bigint: true });
    if (stat.isSymbolicLink()) {
      manifest.limitations.push({ path, kind: 'link_excluded' });
      return;
    }
    if (stat.isDirectory()) {
      if (EXCLUDED_ARTIFACT_DIRECTORIES.has(name))
        manifest.limitations.push({ path, kind: 'unsupported_entry', code: 'excluded_directory' });
      else await visit(full);
      return;
    }
    if (!stat.isFile()) {
      manifest.limitations.push({ path, kind: 'unsupported_entry' });
      return;
    }
    manifest.files.push({ path, size: Number(stat.size) });
    if (relative(scanRoot, directory) !== 'nodes' || !name.endsWith('.meta.json')) return;
    if ((await realpath(directory)) !== resolve(directory)) {
      manifest.limitations.push({ path, kind: 'link_excluded' });
      return;
    }
    await observeSidecar(full, path, stat);
  }
  async function observeSidecar(full: string, path: string, stat: BigIntStats): Promise<void> {
    // Flags vary by platform. Descriptor identity protects the read even when
    // O_NOFOLLOW is unavailable or a parent changes between lookup and open.
    // Keep identities exact: 64-bit file IDs can collide when converted to numbers.
    const platformFlags: Partial<Pick<typeof constants, 'O_NOFOLLOW'>> = constants;
    const handle = await open(full, constants.O_RDONLY | (platformFlags.O_NOFOLLOW ?? 0));
    let raw: string;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        manifest.limitations.push({ path, kind: 'unreadable', code: 'ESTALE' });
        return;
      }
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    try {
      const parsed = nodeArtifactSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || (runId !== undefined && parsed.data.runId !== runId)) {
        manifest.limitations.push({ path, kind: 'invalid_metadata' });
        return;
      }
      metadata.push({ path, value: parsed.data });
    } catch {
      manifest.limitations.push({ path, kind: 'invalid_metadata' });
    }
  }
  await visit(scanRoot);
  for (const entry of metadata) {
    const file = manifest.files.find(file => file.path === portablePath(entry.value.path));
    if (file) file.metadata = entry.value;
    else manifest.limitations.push({ path: entry.path, kind: 'invalid_metadata' });
  }
  return manifest;
}
