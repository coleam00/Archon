import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Engine host writes into a run artifacts directory that a container also mounts
 * read-write. Code in the container can plant symlinks there, so under that root a
 * write refuses a parent that is not a real directory and replaces a leaf instead of
 * writing through it. Outside the scope (host-only runs, other directories) writes
 * behave as plain `mkdir` + `writeFile`.
 *
 * The checks see links that exist before the write; a container swapping a directory
 * for a link between the check and the write is not covered. The root itself is the
 * bind-mount target, which the container cannot replace.
 *
 * A scoped context rather than a parameter: the writers sit several layers below the
 * executor (substitution, output persistence), and a child run re-enters
 * `executeWorkflow` with its own scope, shadowing its parent's.
 */
const containerArtifactsRoot = new AsyncLocalStorage<string | undefined>();

export function withContainerArtifactsRoot<T>(root: string | undefined, operation: () => T): T {
  return containerArtifactsRoot.run(root === undefined ? undefined : resolve(root), operation);
}

export class ArtifactWriteError extends Error {}

interface ContainedParent {
  root: string;
  /** Directory components from the root down to the path's parent. */
  parts: string[];
}

/** Where `path`'s parent sits under the scoped root, or undefined when it is not under one. */
function containedParent(path: string): ContainedParent | undefined {
  const root = containerArtifactsRoot.getStore();
  if (root === undefined) return undefined;
  const rel = relative(root, dirname(resolve(path)));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return { root, parts: rel.split(sep).filter(Boolean) };
}

/**
 * Walk `path`'s parents under the scoped root, refusing any that is not a real
 * directory. Creates missing ones when `create`; otherwise returns false at the first
 * missing one, since nothing below it exists.
 */
function checkParents({ root, parts }: ContainedParent, create: boolean): boolean {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        mkdirSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!entry.isDirectory()) {
      throw new ArtifactWriteError(`Refusing artifact write: '${current}' is not a real directory`);
    }
  }
  return true;
}

/** Create `path`'s parent directory, refusing a symlinked parent under the scoped root. */
export async function prepareArtifactParent(path: string): Promise<void> {
  const contained = containedParent(path);
  if (contained === undefined) await mkdir(dirname(path), { recursive: true });
  else checkParents(contained, true);
}

function temporarySibling(path: string): string {
  return join(dirname(path), `.archon-${randomUUID()}.tmp`);
}

/**
 * Write `value` to `path`, creating its parent. Under the scoped root a new file is
 * renamed over the leaf, so an existing link is replaced and its target untouched.
 */
export async function writeArtifactFile(
  path: string,
  value: string,
  options: { mode?: number } = {}
): Promise<void> {
  const contained = containedParent(path);
  if (contained === undefined) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, { encoding: 'utf8', ...options });
    return;
  }
  checkParents(contained, true);
  const temporary = temporarySibling(path);
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', ...options });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Synchronous {@link writeArtifactFile}, for writers on synchronous substitution paths. */
export function writeArtifactFileSync(path: string, value: string): void {
  const contained = containedParent(path);
  if (contained === undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return;
  }
  checkParents(contained, true);
  const temporary = temporarySibling(path);
  try {
    writeFileSync(temporary, value, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Remove `path` if present, refusing a symlinked parent under the scoped root. */
export async function removeArtifactFile(path: string): Promise<void> {
  const contained = containedParent(path);
  if (contained !== undefined && !checkParents(contained, false)) return;
  await rm(path, { force: true });
}
