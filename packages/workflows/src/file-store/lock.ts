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
    public readonly owner: ProcessOwner
  ) {
    super(
      `File store lock ${path} is held by ${owner.host}:${String(owner.pid)} (${owner.instance}). ` +
        'Check the owner before explicitly removing the lock; elapsed time does not prove death.'
    );
    this.name = 'FileStoreLockHeldError';
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
 * while open and stays delete-pending until the last handle closes. Every lock
 * file operation that can race a release or a replace retries those codes a
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
  const owner: unknown = JSON.parse(contents);
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
    throw new Error(`Invalid owner record in file store lock ${path}; inspect it manually.`);
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

async function acquire(root: string, timeoutMs: number): Promise<() => Promise<void>> {
  const path = join(root, 'lock');
  const breaker = join(root, 'lock.break');
  const candidate = join(root, `.lock-${randomUUID()}`);
  await writeOwner(candidate);
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  let lastOwner: ProcessOwner | null = null;
  try {
    for (;;) {
      if (await tryLink(candidate, path)) return () => remove(path);
      const owner = await readOwner(path);
      if (!owner) {
        // The holder released between our link and read. Retry at once, but a
        // lock that keeps changing hands must not outlast the deadline.
        if (lastOwner && Date.now() >= deadline) throw new FileStoreLockHeldError(path, lastOwner);
        continue;
      }
      lastOwner = owner;
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
            await remove(breaker);
          }
          continue;
        }
        const breakOwner = await readOwner(breaker);
        // A second automatic breaker would recreate the race this mutex prevents.
        if (breakOwner && (isOwnerProvablyGone(breakOwner) || Date.now() >= deadline)) {
          throw new FileStoreLockHeldError(breaker, breakOwner);
        }
      }
      if (Date.now() >= deadline) throw new FileStoreLockHeldError(path, owner);
      await Bun.sleep(5 + Math.floor(Math.random() * 10));
    }
  } finally {
    await remove(candidate);
  }
}

export async function probeFileStoreFilesystem(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const source = join(root, `.probe-${randomUUID()}`);
  const target = `${source}.link`;
  try {
    await writeOwner(source);
    try {
      await link(source, target);
    } catch (error) {
      throw new FileStoreUnsupportedFilesystemError(root, error);
    }
  } finally {
    await remove(target);
    await remove(source);
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
    try {
      return await operation();
    } finally {
      await release();
    }
  } finally {
    finish();
    if (queues.get(key) === pending) queues.delete(key);
  }
}
