import type { IsolationBlockReason } from './types';

/**
 * Error thrown when isolation is required but cannot be provided.
 * This error signals that ALL message handling should stop - not just workflows.
 * The user has already been notified of the specific reason (worktree limit reached,
 * isolation creation failure, etc.) before this error is thrown.
 */
export class IsolationBlockedError extends Error {
  readonly reason: IsolationBlockReason;

  constructor(message: string, reason: IsolationBlockReason) {
    super(message);
    this.name = 'IsolationBlockedError';
    this.reason = reason;
  }
}

/**
 * Single source of truth for isolation error classification.
 *
 * `known: true` means the error is a recognized infrastructure/config failure
 * that should produce a user-facing "blocked" message. `known: false` means
 * it's classifiable (we have a helpful message) but still a programming /
 * user-input bug that should crash rather than be absorbed as blocked state.
 */
const ERROR_PATTERNS: { pattern: string; message: string; known: boolean }[] = [
  {
    pattern: 'permission denied',
    message:
      '**Error:** Permission denied while creating workspace. Check file system permissions.',
    known: true,
  },
  {
    pattern: 'eacces',
    message:
      '**Error:** Permission denied while creating workspace. Check file system permissions.',
    known: true,
  },
  {
    pattern: 'timeout',
    message: '**Error:** Timed out creating workspace. Git repository may be slow or unavailable.',
    known: true,
  },
  {
    pattern: 'no space left',
    message: '**Error:** No disk space available for new workspace.',
    known: true,
  },
  {
    pattern: 'enospc',
    message: '**Error:** No disk space available for new workspace.',
    known: true,
  },
  {
    pattern: 'not a git repository',
    message: '**Error:** Target path is not a valid git repository.',
    known: true,
  },
  {
    // Deliberately not `known` — this is a user-input / registration bug,
    // not an infrastructure failure. Surface classification, but crash.
    pattern: 'cannot extract owner/repo',
    message:
      '**Error:** Repository path is too short to extract owner and repo name. ' +
      'Re-register the codebase with a full path (e.g. `/home/user/owner/repo`).',
    known: false,
  },
  {
    pattern: 'branch not found',
    message:
      '**Error:** Branch not found. The requested branch may have been deleted or not yet pushed.',
    known: true,
  },
  {
    pattern: 'no base branch configured',
    message:
      '**Error:** No base branch configured. Set `worktree.baseBranch` in `.archon/config.yaml` ' +
      'or use the `--from` flag to select a branch (e.g., `--from dev`).',
    known: true,
  },
  {
    pattern: 'belongs to a different clone',
    message:
      '**Error:** A worktree at the target path was created by a different local clone. ' +
      'Remove it from that clone, or register this codebase from the same local path.',
    known: true,
  },
  {
    pattern: 'cannot verify worktree ownership',
    message:
      '**Error:** Cannot verify ownership of an existing worktree at the target path. ' +
      'Check file system permissions and remove any unrelated git directories at that path.',
    known: true,
  },
  {
    pattern: 'cannot adopt',
    message:
      '**Error:** Refused to adopt an existing directory at the worktree path. ' +
      'Remove it or choose a different branch/codebase registration.',
    known: true,
  },
  {
    pattern: 'submodule initialization failed',
    message:
      '**Error:** Submodule initialization failed. Check credentials and network access to ' +
      'submodule remotes, or set `worktree.initSubmodules: false` in `.archon/config.yaml` ' +
      'to opt out if submodules are not needed for your workflows.',
    known: true,
  },
];

/**
 * Classify isolation creation errors into user-friendly messages.
 */
export function classifyIsolationError(err: Error): string {
  const stderr = (err as Error & { stderr?: string }).stderr ?? '';
  const errorLower = `${err.message} ${stderr}`.toLowerCase();

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (errorLower.includes(pattern)) {
      return message;
    }
  }

  return `**Error:** Could not create isolated workspace (${err.message}).`;
}

/**
 * Returns true if the error is a known infrastructure failure that should
 * produce a user-facing "blocked" message rather than a crash.
 *
 * Unknown errors (programming bugs, unexpected failures) should propagate
 * so they are visible as crashes rather than silent workspace failures.
 */
export function isKnownIsolationError(err: Error): boolean {
  const stderr = (err as Error & { stderr?: string }).stderr ?? '';
  const errorLower = `${err.message} ${stderr}`.toLowerCase();

  return ERROR_PATTERNS.some(({ pattern, known }) => known && errorLower.includes(pattern));
}
