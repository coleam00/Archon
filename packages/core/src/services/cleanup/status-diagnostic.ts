import { GitFailure, type GitFailureKind } from '@archon/git';
import { InvalidConfigError } from '../../config/config-validation';

const gitFailureReasons = {
  timeout: 'Git operation timed out',
  unclassified: 'Git operation failed',
  not_repository: 'Repository is missing or is not a Git repository',
  adoption_refused: 'Repository adoption refused',
  different_clone: 'Repository belongs to a different clone',
  ownership_unverified: 'Repository ownership could not be verified',
  default_branch_missing: 'Remote default branch is unavailable',
} satisfies Record<GitFailureKind, string>;

export function statusDiagnostic(error: unknown): string {
  // Git/config errors can echo transformed remotes and arbitrary config values.
  // Only structured failure categories are safe to publish, never their prose.
  if (error instanceof InvalidConfigError) return 'Invalid repository configuration';
  if (error instanceof GitFailure) {
    const reason = gitFailureReasons[error.kind];
    return typeof error.code === 'number' ? `${reason} (exit code ${error.code})` : reason;
  }
  return 'Operation failed (unstructured diagnostic omitted to protect credentials)';
}
