import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  currentProcessOwner,
  isOwnerProvablyGone,
  type ProcessOwner,
} from '@archon/paths/process-owner';
import { createLogger } from '@archon/paths/logger';

const log = createLogger('file-store');
const queues = new Map<string, Promise<void>>();

export class FileStoreLockHeldError extends Error {
  constructor(
    public readonly path: string,
    /** Null when the lock name exists but its owner record cannot be read. */
    public readonly owner: ProcessOwner | null
  ) {
    super(
      `File store lock ${path} is held by ${
        owner
          ? `${owner.host}:${String(owner.pid)} (${owner.instance})`
          : 'an owner whose record cannot be read'
      }. Check the owner before explicitly removing the lock; elapsed time does not prove death.`
    );
    this.name = 'FileStoreLockHeldError';
  }
}

export class FileStoreLockRecordError extends Error {
  constructor(
    public readonly path: string,
    cause?: unknown
  ) {
    super(`Invalid owner record in file store lock ${path}; inspect it manually.`, { cause });
    this.name = 'FileStoreLockRecordError';
  }
}

/**
 * The operation completed, but its lock could not be removed. The lock still
 * names this process; the next call from this process reclaims it.
 */
export class FileStoreLockReleaseError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown
  ) {
    super(`File store lock ${path} could not be released after the operation completed.`, {
      cause,
    });
    this.name = 'FileStoreLockReleaseError';
  }
}

export class FileStoreUnsupportedFilesystemError extends Error {
  constructor(root: string, cause: unknown) {
    super(`File store ${root} requires a local filesystem supporting hard links.`, { cause });
    this.name = 'FileStoreUnsupportedFilesystemError';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

const windowsHandleCodes = ['EPERM', 'EBUSY', 'EACCES'];

/**
 * Windows reports a name it cannot touch yet as EPERM, EBUSY or EACCES: another
 * process holds a handle that denies delete sharing, or the file was unlinked
 * while open and stays delete-pending until the last handle closes. Every read,
 * link, rename and unlink of a shared lock or store file retries those codes a
 * bounded number of times; the retry never changes what the operation decides.
 */
async function retryWindowsHandles<T>(
  operation: string,
  path: string,
  attempt: () => Promise<T>
): Promise<{ value: T; retries: number }> {
  const codes: string[] = [];
  for (;;) {
    try {
      const value = await attempt();
      if (codes.length > 0) {
        log.debug({ operation, path, codes }, 'file_store.windows_handle_retry');
      }
      return { value, retries: codes.length };
    } catch (error) {
      const code = windowsHandleCodes.find(candidate => hasCode(error, candidate));
      if (process.platform !== 'win32' || codes.length === 20 || !code) throw error;
      codes.push(code);
      await Bun.sleep(10);
    }
  }
}

export async function renameReplacing(source: string, target: string): Promise<number> {
  const { retries } = await retryWindowsHandles('rename', target, () => rename(source, target));
  return retries;
}

async function remove(path: string): Promise<void> {
  await retryWindowsHandles('unlink', path, async () => {
    try {
      await unlink(path);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  });
}

/** Removes a private scratch file. Its failure must never replace the caller's outcome. */
async function discard(path: string): Promise<void> {
  try {
    await remove(path);
  } catch (error) {
    log.warn({ path, err: error }, 'file_store.cleanup_failed');
  }
}

async function writeOwner(path: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(currentProcessOwner));
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readOwner(path: string): Promise<ProcessOwner | null> {
  const { value: contents } = await retryWindowsHandles('read', path, async () => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
  });
  if (contents === null) return null;
  let owner: unknown;
  try {
    owner = JSON.parse(contents);
  } catch (error) {
    throw new FileStoreLockRecordError(path, error);
  }
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('host' in owner) ||
    typeof owner.host !== 'string' ||
    !('pid' in owner) ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !('instance' in owner) ||
    typeof owner.instance !== 'string'
  ) {
    throw new FileStoreLockRecordError(path);
  }
  return { host: owner.host, pid: owner.pid, instance: owner.instance };
}

function sameOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return a.host === b.host && a.pid === b.pid && a.instance === b.instance;
}

async function tryLink(source: string, target: string): Promise<boolean> {
  const { value } = await retryWindowsHandles('link', target, async () => {
    try {
      await link(source, target);
      return true;
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false;
      throw error;
    }
  });
  return value;
}

/**
 * Callers reach this only at the head of the in-process queue for `root`, so a
 * `lock` or `lock.break` naming this exact process is a leftover from a failed
 * removal here, never a live holder, and is reclaimed instead of waited on.
 */
async function acquire(root: string, timeoutMs: number): Promise<() => Promise<void>> {
  const path = join(root, 'lock');
  const breaker = join(root, 'lock.break');
  const candidate = join(root, `.lock-${randomUUID()}`);
  await writeOwner(candidate);
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  try {
    for (;;) {
      if (await tryLink(candidate, path)) return () => remove(path);
      const owner = await readOwner(path);
      if (!owner) {
        // The holder released between our link and read; retry at once. A name
        // that keeps existing for link but not for read must not outlast the deadline.
        if (Date.now() >= deadline) throw new FileStoreLockHeldError(path, null);
        continue;
      }
      if (sameOwner(owner, currentProcessOwner)) {
        log.warn({ path }, 'file_store.lock_reclaimed');
        await remove(path);
        continue;
      }
      if (!reported) {
        log.info({ path, owner }, 'file_store.lock_wait');
        reported = true;
      }
      if (isOwnerProvablyGone(owner)) {
        if (await tryLink(candidate, breaker)) {
          try {
            const now = await readOwner(path);
            if (now && sameOwner(owner, now) && isOwnerProvablyGone(now)) await remove(path);
          } finally {
            await discard(breaker);
          }
          continue;
        }
        const breakOwner = await readOwner(breaker);
        if (breakOwner && sameOwner(breakOwner, currentProcessOwner)) {
          log.warn({ path: breaker }, 'file_store.lock_reclaimed');
          await remove(breaker);
          continue;
        }
        // A second automatic breaker would recreate the race this mutex prevents.
        if (breakOwner && (isOwnerProvablyGone(breakOwner) || Date.now() >= deadline)) {
          throw new FileStoreLockHeldError(breaker, breakOwner);
        }
      }
      if (Date.now() >= deadline) throw new FileStoreLockHeldError(path, owner);
      await Bun.sleep(5 + Math.floor(Math.random() * 10));
    }
  } finally {
    await discard(candidate);
  }
}

/** Codes a hard link fails with when the filesystem cannot create one at all. */
const unsupportedLinkCodes = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'];

export async function probeFileStoreFilesystem(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const source = join(root, `.probe-${randomUUID()}`);
  const target = `${source}.link`;
  try {
    await writeOwner(source);
    try {
      await retryWindowsHandles('link', target, () => link(source, target));
    } catch (error) {
      if (unsupportedLinkCodes.some(code => hasCode(error, code))) {
        throw new FileStoreUnsupportedFilesystemError(root, error);
      }
      throw error;
    }
  } finally {
    await discard(target);
    await discard(source);
  }
}

export async function withFileStoreLock<T>(
  root: string,
  operation: () => Promise<T>,
  timeoutMs = 10_000
): Promise<T> {
  const key = await realpath(root);
  const previous = queues.get(key) ?? Promise.resolve();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => (finish = resolve));
  queues.set(key, pending);
  await previous;
  try {
    const release = await acquire(key, timeoutMs);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      try {
        await release();
      } catch (releaseError) {
        log.warn({ path: join(key, 'lock'), err: releaseError }, 'file_store.release_failed');
      }
      throw error;
    }
    try {
      await release();
    } catch (error) {
      throw new FileStoreLockReleaseError(join(key, 'lock'), error);
    }
    return result;
  } finally {
    finish();
    if (queues.get(key) === pending) queues.delete(key);
  }
}
