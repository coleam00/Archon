import { INSTALLED_SCOPE_DIR, installedSourceUnit } from './roots';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sourceReadError, WorkflowSourceIntegrityError } from './integrity';
import type { IndexedWorkflowSourceManifest } from './manifest';
import type { SourceUnit } from './unit-index';

async function assertUnitDirectory(captureRoot: string, root: string): Promise<void> {
  const path = join(captureRoot, root);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkflowSourceIntegrityError(
      `Captured source unit is not a directory: ${path}`,
      captureRoot
    );
  }
  if (path !== captureRoot)
    await assertUnitDirectory(captureRoot, dirname(root) === '.' ? '' : dirname(root));
}

async function verifyUnit(captureRoot: string, unit: SourceUnit): Promise<string[]> {
  const expected = new Map(unit.files.map(file => [file.path, file]));
  const found = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    const directory = join(captureRoot, unit.root, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        const file = expected.get(path);
        if (!entry.isFile() || file === undefined) {
          throw new WorkflowSourceIntegrityError(
            `Unexpected captured source entry: ${join(directory, entry.name)}`,
            captureRoot
          );
        }
        const content = await readFile(join(directory, entry.name));
        if (
          content.length !== file.size ||
          createHash('sha256').update(content).digest('hex') !== file.hash
        ) {
          throw new WorkflowSourceIntegrityError(
            `Workflow source capture at ${captureRoot} does not match its recorded digest: ${unit.root}/${path}. ` +
              'The captured source has changed since the run started.',
            captureRoot
          );
        }
        found.add(path);
      }
    }
  };
  try {
    await assertUnitDirectory(captureRoot, unit.root);
    await walk('');
    for (const file of unit.files) {
      if (!found.has(file.path)) {
        // Preserve the host-read cause for a committed file that disappeared.
        await readFile(join(captureRoot, unit.root, file.path));
        throw new WorkflowSourceIntegrityError(
          `Captured source file was not enumerated: ${file.path}`,
          captureRoot
        );
      }
    }
  } catch (error) {
    throw sourceReadError(captureRoot, error);
  }
  return [...found].map(path => join(captureRoot, unit.root, path));
}

/** Internal: callers authenticate the manifest before choosing units from it. */
export async function verifyIndexedUnits(
  captureRoot: string,
  manifest: IndexedWorkflowSourceManifest,
  roots: readonly string[]
): Promise<ReadonlySet<string>> {
  const files = new Set<string>();
  for (const root of new Set(roots)) {
    const unit = manifest.units.find(candidate => candidate.root === root);
    if (unit === undefined) {
      throw new WorkflowSourceIntegrityError(
        `Source unit is not in the authenticated index: ${root}`,
        captureRoot
      );
    }
    for (const file of await verifyUnit(captureRoot, unit)) files.add(file);
  }
  return files;
}

/** Full verification also refuses payload roots that have no authenticated unit. */
export async function assertIndexedLayout(
  captureRoot: string,
  manifest: IndexedWorkflowSourceManifest
): Promise<void> {
  try {
    for (const entry of await readdir(captureRoot, { withFileTypes: true })) {
      if (entry.name === 'manifest.json' && entry.isFile()) continue;
      if (!entry.isDirectory() || !manifest.scopes.some(scope => scope === entry.name)) {
        throw new WorkflowSourceIntegrityError(`Unindexed source root: ${entry.name}`, captureRoot);
      }
      if (entry.name === INSTALLED_SCOPE_DIR) await assertInstalledLayout(captureRoot, manifest);
    }
  } catch (error) {
    throw sourceReadError(captureRoot, error);
  }
}

async function assertInstalledLayout(
  captureRoot: string,
  manifest: IndexedWorkflowSourceManifest
): Promise<void> {
  const roots = new Set(manifest.units.map(unit => unit.root));
  for (const pack of await readdir(join(captureRoot, INSTALLED_SCOPE_DIR), {
    withFileTypes: true,
  })) {
    if (!pack.isDirectory() || !roots.has(installedSourceUnit(pack.name))) {
      throw new WorkflowSourceIntegrityError(
        `Unindexed installed source: ${pack.name}`,
        captureRoot
      );
    }
  }
}
