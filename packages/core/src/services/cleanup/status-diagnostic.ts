import { GitFailure } from '@archon/git';
import { InvalidConfigError } from '../../config/config-validation';

export function statusDiagnostic(error: unknown): string {
  // Git/config errors can echo transformed remotes and arbitrary config values.
  // Only structured failure categories are safe to publish, never their prose.
  if (error instanceof InvalidConfigError) return 'Invalid repository configuration';
  if (error instanceof GitFailure) {
    let reason = 'Git operation failed';
    if (error.kind === 'default_branch_missing') reason = 'Remote default branch is unavailable';
    else if (error.kind === 'timeout') reason = 'Git operation timed out';
    return typeof error.code === 'number' ? `${reason} (exit code ${error.code})` : reason;
  }
  return 'Operation failed (unstructured diagnostic omitted to protect credentials)';
}
