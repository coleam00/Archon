import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { nodeArtifactSchema } from './schemas/node-artifact';
import type { ArtifactManifest } from './schemas/terminal-record';

/** Observe filenames and sidecars only; output contents never enter a terminal record. */
export async function observeArtifactManifest(
  root: string | null,
  storageRoot?: string,
  runId?: string
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
  async function visit(directory: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      fault(relative(scanRoot, directory), error);
      return;
    }
    for (const name of entries.sort()) {
      const full = join(directory, name);
      const path = portablePath(relative(scanRoot, full));
      try {
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) {
          manifest.limitations.push({ path, kind: 'link_excluded' });
          continue;
        }
        if (stat.isDirectory()) {
          await visit(full);
          continue;
        }
        if (!stat.isFile()) {
          manifest.limitations.push({ path, kind: 'unsupported_entry' });
          continue;
        }
        manifest.files.push({ path, size: stat.size });
        if (relative(scanRoot, directory) !== 'nodes' || !name.endsWith('.meta.json')) continue;
        if ((await realpath(directory)) !== resolve(directory)) {
          manifest.limitations.push({ path, kind: 'link_excluded' });
          continue;
        }
        // Flags vary by platform. Descriptor identity protects the read even when
        // O_NOFOLLOW is unavailable or a parent changes between lookup and open.
        const platformFlags: Partial<Pick<typeof constants, 'O_NOFOLLOW'>> = constants;
        const handle = await open(full, constants.O_RDONLY | (platformFlags.O_NOFOLLOW ?? 0));
        let raw: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            manifest.limitations.push({ path, kind: 'unreadable', code: 'ESTALE' });
            continue;
          }
          raw = await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
        try {
          const parsed = nodeArtifactSchema.safeParse(JSON.parse(raw));
          if (!parsed.success || (runId !== undefined && parsed.data.runId !== runId)) {
            manifest.limitations.push({ path, kind: 'invalid_metadata' });
            continue;
          }
          metadata.push({ path, value: parsed.data });
        } catch {
          manifest.limitations.push({ path, kind: 'invalid_metadata' });
        }
      } catch (error) {
        fault(path, error);
      }
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
