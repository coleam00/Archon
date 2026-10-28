import { stat } from 'fs/promises';
import { sep } from 'path';

/**
 * A capture whose bytes could not be trusted.
 *
 * Distinct from an ordinary Error so callers can fail a run closed on it rather than
 * treat it as one more reason to fall back to live source. Falling back is precisely what
 * the capture exists to prevent.
 */
export class WorkflowSourceIntegrityError extends Error {
  constructor(
    message: string,
    readonly path?: string
  ) {
    super(message);
    this.name = 'WorkflowSourceIntegrityError';
  }
}

export class WorkflowSourceUnavailableError extends WorkflowSourceIntegrityError {
  constructor(
    readonly path: string,
    cause: unknown
  ) {
    super(
      `Workflow source at ${path} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      path
    );
    this.name = 'WorkflowSourceUnavailableError';
    this.cause = cause;
  }
}

export function sourceReadError(path: string, error: unknown): unknown {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'EISDIR':
    case 'EACCES':
    case 'EPERM':
    case 'ELOOP':
      return new WorkflowSourceUnavailableError(path, error);
    default:
      return error;
  }
}

/**
 * True when `error` means this host failed to read the source, as opposed to source that
 * was read and found wrong (a digest mismatch, a replaced capture, an unparseable
 * manifest) or a script absent from it. Typed only: `WorkflowSourceUnavailableError`, or a
 * Node system error (string `code` and `syscall`) on the error or its `cause` chain.
 * Invalid file/directory shapes are recoverable only where the inventory proves the
 * expected file or directory belonged.
 *
 * A capture missing from this host (`ENOENT`) counts: captures live on the host that made
 * them, so another host may still read it. If it never returns, the continuation host's
 * pre-admission check refuses the run and warns after repeated refusals.
 */
export function isSourceReadFailure(error: unknown, verifiedFiles?: ReadonlySet<string>): boolean {
  if (error instanceof WorkflowSourceUnavailableError) return true;
  if (error instanceof WorkflowSourceIntegrityError) return false;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (isSystemError(current)) return isSystemReadFailure(current, verifiedFiles);
  }
  return false;
}

function isSystemReadFailure(
  error: Error & { code: string; syscall: string; path?: unknown },
  verifiedFiles: ReadonlySet<string> | undefined
): boolean {
  if (error.code === 'EISDIR') {
    return typeof error.path === 'string' && verifiedFiles?.has(error.path) === true;
  }
  if (error.code === 'ENOTDIR') {
    const readingDirectory = error.syscall === 'scandir' || error.syscall === 'readdir';
    return (
      typeof error.path === 'string' &&
      ((!readingDirectory && verifiedFiles?.has(error.path) === true) ||
        hasVerifiedFileBelow(verifiedFiles, error.path))
    );
  }
  return true;
}

function hasVerifiedFileBelow(
  verifiedFiles: ReadonlySet<string> | undefined,
  path: string
): boolean {
  return (
    verifiedFiles !== undefined && [...verifiedFiles].some(file => file.startsWith(path + sep))
  );
}

/** Discovery may omit vanished entries without a syscall error; the verified inventory cannot. */
export async function assertCapturedFilesPresent(
  verifiedFiles: ReadonlySet<string> | undefined
): Promise<void> {
  if (!verifiedFiles) return;
  await Promise.all(
    [...verifiedFiles].map(async path => {
      const info = await stat(path);
      if (!info.isFile()) {
        throw new WorkflowSourceUnavailableError(
          path,
          new Error('Verified source file is no longer a file')
        );
      }
    })
  );
}

/** Missing live paths are optional; a path containing verified captured files is not. */
export function capturedSourceReadGuard(
  verifiedFiles: ReadonlySet<string> | undefined
): (path: string, error: unknown) => void {
  return (path, error) => {
    if (verifiedFiles?.has(path) || hasVerifiedFileBelow(verifiedFiles, path)) {
      throw error;
    }
  };
}

/** A Node or Bun system call failure, such as `readdir` failing with `EACCES`. */
export function isSystemError(
  error: unknown
): error is Error & { code: string; syscall: string; path?: unknown } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { syscall?: unknown }).syscall === 'string'
  );
}
