/**
 * Public surface for the GitHub App auth module.
 */
export { createGitHubAppAuthProvider } from './auth';
export { loadAppPrivateKey } from './private-key';
export { AppNotInstalledError, AppPrivateKeyError } from './errors';
export { installCredentialHelper } from './credential-helper-install';
export type { GitHubAppConfig, IGitHubAppAuthProvider, CachedInstallationToken } from './types';

import type { IGitHubAppAuthProvider } from './types';

/**
 * Discriminated union consumed by GitHubAdapter at construction time. The
 * adapter narrows on `kind` rather than runtime feature detection so the
 * compiler enforces every callsite handles both modes.
 */
export type GitHubAuth =
  | { kind: 'pat'; token: string }
  | { kind: 'app'; provider: IGitHubAppAuthProvider };
