/**
 * Environment-backed GitHub App configuration, clone token-source precedence,
 * and per-user GitHub auth (device flow + token encryption at rest).
 *
 * Per-user attribution is an opt-in layer on top of the GitHub App. The feature
 * gate (`isPerUserGitHubEnabled`) is active only when BOTH the App is configured
 * (GITHUB_APP_ID) and a token-encryption key (TOKEN_ENCRYPTION_KEY) is present.
 * GITHUB_APP_CLIENT_ID is additionally required for the device flow itself
 * (`loadDeviceFlowConfig`) — without it the gate/scrub still activate but every
 * connect attempt throws, so all three env vars must be set together. Solo PAT
 * installs (no GITHUB_APP_ID) and App installs that haven't set
 * TOKEN_ENCRYPTION_KEY see every per-user code path as a no-op.
 */
import { createPrivateKey } from 'node:crypto';
import { loadAppPrivateKey } from './private-key';
import { AppPrivateKeyError } from './errors';
import type { GitHubAppConfig } from './types';
import { getEncryptionKey } from '../utils/token-crypto';

export interface DeviceFlowConfig {
  /** GitHub App client id (the `Iv1.`/`Iv23…` value, distinct from GITHUB_APP_ID). */
  clientId: string;
}

export function resolveGitHubTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  if (
    ![env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_APP_PRIVATE_KEY_PATH].some(Boolean)
  ) {
    return null;
  }
  if (env.GITHUB_TOKEN) {
    throw new Error(
      'GitHub authentication misconfigured: both App mode (GITHUB_APP_ID) and PAT mode ' +
        '(GITHUB_TOKEN) are configured. Pick one: unset GITHUB_TOKEN for App mode, ' +
        'or unset GITHUB_APP_ID and its private key for PAT mode.'
    );
  }
  const appId = env.GITHUB_APP_ID?.trim();
  if (!appId || !/^[0-9]+$/.test(appId) || !/[1-9]/.test(appId)) {
    throw new AppPrivateKeyError('GITHUB_APP_ID must be a positive decimal App ID.');
  }
  const slug = env.GITHUB_APP_SLUG === undefined ? 'archon' : env.GITHUB_APP_SLUG.trim();
  if (!slug) throw new AppPrivateKeyError('GITHUB_APP_SLUG must not be blank.');
  let defaultInstallationId: number | undefined;
  if (env.GITHUB_APP_INSTALLATION_ID !== undefined) {
    const raw = env.GITHUB_APP_INSTALLATION_ID;
    defaultInstallationId = Number(raw);
    if (
      !/^[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(defaultInstallationId) ||
      defaultInstallationId <= 0
    ) {
      throw new AppPrivateKeyError(
        'GITHUB_APP_INSTALLATION_ID must be a positive safe decimal integer.'
      );
    }
  }
  const privateKey = loadAppPrivateKey(env);
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') {
      throw new Error('RSA required');
    }
  } catch {
    throw new AppPrivateKeyError(
      'GitHub App private key must be a usable RSA PEM private key. Check GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH.'
    );
  }
  assertEncryptionKeyAtBoot(env);
  return { appId, privateKey, slug, defaultInstallationId };
}

/**
 * Per-user GitHub attribution is active only when the GitHub App is configured
 * AND a token-encryption key is present.
 */
export function isPerUserGitHubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.TOKEN_ENCRYPTION_KEY);
}

/**
 * Resolve the GitHub App client id used for the device flow. Throws if missing
 * so the connect surfaces fail fast with an actionable message rather than
 * issuing a malformed device-code request.
 */
export function loadDeviceFlowConfig(env: NodeJS.ProcessEnv = process.env): DeviceFlowConfig {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error(
      'GITHUB_APP_CLIENT_ID is required for the GitHub device flow. ' +
        'Find it on the GitHub App settings page (the client id, starts with "Iv1." or "Iv23").'
    );
  }
  return { clientId };
}

/**
 * Fail fast at host bootstrap: when per-user GitHub is enabled, the encryption key
 * must be present and well-formed. `getEncryptionKey()` throws otherwise, so a
 * misconfigured deployment never silently stores unencryptable tokens.
 */
export function assertEncryptionKeyAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  if (isPerUserGitHubEnabled(env)) {
    getEncryptionKey(env);
  }
}
