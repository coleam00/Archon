import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// The canonical tree is never mounted writable in the producer. These checks
// cover pre-existing links, not concurrent mutation by another host process.
// Async scope shares the policy with synchronous interpolation without a root registry.
const roots = new AsyncLocalStorage<string | undefined>();

export function withArtifactWriteRoot<T>(root: string | undefined, operation: () => T): T {
  return roots.run(root === undefined ? undefined : resolve(root), operation);
}

const failureObservers = new AsyncLocalStorage<(error: unknown) => void>();

export function withArtifactWriteFailureObserver<T>(
  observer: (error: unknown) => void,
  operation: () => T
): T {
  return failureObservers.run(observer, operation);
}

function reportWriteFailure(error: unknown): void {
  if (roots.getStore() !== undefined) failureObservers.getStore()?.(error);
}

export function isProtectedArtifactPath(path: string): boolean {
  const root = roots.getStore();
  if (root === undefined) return false;
  const rel = relative(root, resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export class ArtifactWriteError extends Error {}

function checkedParent(path: string): void {
  const root = roots.getStore();
  if (root === undefined) return;
  if (!isProtectedArtifactPath(path))
    throw new ArtifactWriteError('Artifact write escapes its canonical root');
  const parent = dirname(resolve(path));
  if (!isProtectedArtifactPath(parent))
    throw new ArtifactWriteError('Cannot replace the canonical artifact root');
  const parts = relative(root, parent).split(sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = resolve(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      mkdirSync(current, { recursive: current === root });
      entry = lstatSync(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ArtifactWriteError(`Artifact parent '${current}' must be a real directory`);
    }
  }
}

export async function prepareArtifactParent(path: string): Promise<void> {
  if (roots.getStore() === undefined) await mkdir(dirname(path), { recursive: true });
  else checkedParent(path);
}

export async function writeArtifactFile(path: string, value: string, mode?: number): Promise<void> {
  try {
    await prepareArtifactParent(path);
    if (roots.getStore() === undefined) {
      await writeFile(path, value, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
      return;
    }
    const temporary = resolve(dirname(path), `.archon-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, value, { flag: 'wx', mode: mode ?? 0o644 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    reportWriteFailure(error);
    throw error;
  }
}

export function writeArtifactFileSync(path: string, value: string): void {
  try {
    if (roots.getStore() === undefined) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value);
      return;
    }
    checkedParent(path);
    const temporary = resolve(dirname(path), `.archon-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, value, { flag: 'wx', mode: 0o644 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    reportWriteFailure(error);
    throw error;
  }
}

export async function removeArtifactFile(path: string): Promise<void> {
  if (roots.getStore() !== undefined) checkedParent(path);
  await rm(path, { force: true });
}
