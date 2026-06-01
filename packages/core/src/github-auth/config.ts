/**
 * Boot-time configuration helpers for per-user GitHub auth (device flow +
 * token encryption at rest).
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
import { getEncryptionKey } from '../utils/token-crypto';

export interface DeviceFlowConfig {
  /** GitHub App client id (the `Iv1.`/`Iv23…` value, distinct from GITHUB_APP_ID). */
  clientId: string;
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
 * Fail fast at server boot: when per-user GitHub is enabled, the encryption key
 * must be present and well-formed. `getEncryptionKey()` throws otherwise, so a
 * misconfigured deployment never silently stores unencryptable tokens.
 */
export function assertEncryptionKeyAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  if (isPerUserGitHubEnabled(env)) {
    getEncryptionKey(env);
  }
}
