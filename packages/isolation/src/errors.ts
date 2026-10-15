import { GitFailure, ConfiguredBaseBranchNotFoundError, type GitFailureKind } from '@archon/git';
import type { WorktreeSetupFailureKind } from '@archon/workflows/schemas/worktree-setup';

export class WorktreePostCreateError extends Error {
  constructor(
    readonly commandIndex: number,
    readonly command: string,
    readonly failureKind: WorktreeSetupFailureKind,
    detail: string,
    readonly exitCode?: number,
    readonly errno?: string,
    readonly signal?: string,
    cause?: unknown
  ) {
    super(`worktree.postCreate command ${commandIndex + 1} (${command}) ${detail}`, { cause });
    this.name = 'WorktreePostCreateError';
  }
}

import type { IsolationBlockReason } from './types';

export class MissingProjectDirectoryError extends Error {
  constructor(repoPath: string, project: string) {
    super(
      `Project '${project}' directory is missing: ${repoPath}. ` +
        'Restore the directory or re-register the project with its current path.'
    );
    this.name = 'MissingProjectDirectoryError';
  }
}

/**
 * An existing branch and its remote counterpart both hold commits the other lacks.
 * Either side may be the only copy of someone's work, so creation stops instead of
 * choosing one.
 */
export class ExistingBranchDivergedError extends Error {
  constructor(branch: string, remoteRef: string, localOnly: number, remoteOnly: number) {
    super(
      `Branch '${branch}' has diverged from '${remoteRef}': the local branch has ${localOnly} commit(s) the remote does not, and the remote has ${remoteOnly} the local branch does not. ` +
        `Archon will not pick a side. Reconcile them (rebase or merge, then push), or delete the local branch to start from '${remoteRef}', then retry.`
    );
    this.name = 'ExistingBranchDivergedError';
  }
}

export class WorktreeUncommittedChangesError extends Error {
  constructor(readonly path: string) {
    super(`Worktree at ${path} has uncommitted changes.`);
    this.name = 'WorktreeUncommittedChangesError';
  }
}

/**
 * Git unregistered a worktree it was removing but left files behind that Archon
 * could not delete. No retry can prove the directory is Archon's again, so the
 * operator must delete it by hand.
 */
export class WorktreeLeftoverError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
    detail: string
  ) {
    super(
      `Git unregistered the worktree at ${path} but left files it could not delete, and removing them failed (${detail}). Retrying abandon cannot finish this; delete ${path} by hand.`,
      { cause }
    );
    this.name = 'WorktreeLeftoverError';
  }
}

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

export type IsolationFailureKind =
  | GitFailureKind
  | 'permission_denied'
  | 'no_space'
  | 'configured_branch_missing'
  | 'submodule_failed'
  | 'branch_exists'
  | 'path_exists'
  | 'worktree_registered'
  | 'setup_unfinished';

export class IsolationFailure extends Error {
  constructor(
    readonly kind: IsolationFailureKind,
    message: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'IsolationFailure';
  }
}

const FAILURE_MESSAGES = {
  permission_denied:
    '**Error:** Permission denied while creating workspace. Check file system permissions.',
  timeout: '**Error:** Timed out creating workspace. Git repository may be slow or unavailable.',
  no_space: '**Error:** No disk space available for new workspace.',
  not_repository: '**Error:** Target path is not a valid git repository.',
  configured_branch_missing: undefined,
  default_branch_missing:
    '**Error:** No base branch could be detected. Set `worktree.baseBranch` in ' +
    '`.archon/config.yaml` or update the registered codebase default branch.',
  different_clone:
    '**Error:** A worktree at the target path was created by a different local clone. ' +
    'Remove it from that clone, or register this codebase from the same local path.',
  ownership_unverified:
    '**Error:** Cannot verify ownership of an existing worktree at the target path. ' +
    'Check file system permissions and remove any unrelated git directories at that path.',
  adoption_refused:
    '**Error:** Refused to adopt an existing directory at the worktree path. ' +
    'Remove it or choose a different branch/codebase registration.',
  submodule_failed:
    '**Error:** Submodule initialization failed. Check credentials and network access to ' +
    'submodule remotes, or set `worktree.initSubmodules: false` in `.archon/config.yaml` ' +
    'to opt out if submodules are not needed for your workflows.',
  unclassified: undefined,
  branch_exists: undefined,
  path_exists: undefined,
  worktree_registered: undefined,
  setup_unfinished: undefined,
} satisfies Record<IsolationFailureKind, string | undefined>;

type ErrorWithCleanupFailure = Error & { cleanupFailure?: string };

/**
 * Record that the cleanup this error triggered did not finish, so the operator
 * learns what was left behind without losing the cause that started it.
 */
export function recordCleanupFailure(err: Error, detail: string): void {
  (err as ErrorWithCleanupFailure).cleanupFailure = detail;
}

function failureKind(err: Error): IsolationFailureKind | undefined {
  if (err instanceof WorktreePostCreateError) return undefined;
  if ((err instanceof IsolationFailure || err instanceof GitFailure) && err.kind !== 'unclassified')
    return err.kind;
  if (err instanceof ConfiguredBaseBranchNotFoundError) return 'configured_branch_missing';
  if ('code' in err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') return 'permission_denied';
    if (err.code === 'ENOSPC') return 'no_space';
    if (err.code === 'ETIMEDOUT') return 'timeout';
  }
  const causeKind = err.cause instanceof Error ? failureKind(err.cause) : undefined;
  return (
    causeKind ??
    (err instanceof IsolationFailure || err instanceof GitFailure ? 'unclassified' : undefined)
  );
}

export function classifyIsolationError(err: Error): string {
  const kind = failureKind(err);
  const message = kind === undefined ? undefined : FAILURE_MESSAGES[kind];
  const classified =
    message ??
    (isKnownIsolationError(err)
      ? `**Error:** ${err.message}`
      : `**Error:** Could not create isolated workspace (${err.message}).`);
  const cleanupFailure = (err as ErrorWithCleanupFailure).cleanupFailure;
  return cleanupFailure ? `${classified} ${cleanupFailure}` : classified;
}

export function isKnownIsolationError(err: Error): boolean {
  return (
    err instanceof WorktreePostCreateError ||
    err instanceof MissingProjectDirectoryError ||
    err instanceof ExistingBranchDivergedError ||
    failureKind(err) !== undefined
  );
}
