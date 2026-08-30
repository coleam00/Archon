/**
 * Boot-time configuration helpers for per-user GitHub auth (device flow +
 * token encryption at rest).
 *
 * Per-user attribution is enabled when GITHUB_CLIENT_ID (OAuth App) and
 * TOKEN_ENCRYPTION_KEY are both set. Every GitHub operation requires a
 * per-user token from the vault — there is no bot/PAT fallback.
 */
import { getEncryptionKey } from '../utils/token-crypto';

export interface DeviceFlowConfig {
  /** OAuth App client ID from GitHub → Settings → Developer settings → OAuth Apps. */
  clientId: string;
}

/**
 * Per-user GitHub attribution is active when the OAuth App client ID and a
 * token-encryption key are both present.
 */
export function isPerUserGitHubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.TOKEN_ENCRYPTION_KEY);
}

/**
 * Resolve the OAuth App client ID used for the device flow. Throws if missing
 * so the connect surface fails fast with an actionable message rather than
 * issuing a malformed device-code request.
 */
export function loadDeviceFlowConfig(env: NodeJS.ProcessEnv = process.env): DeviceFlowConfig {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error(
      'GITHUB_CLIENT_ID is required for the GitHub device flow. ' +
        'Set it to the OAuth App client ID from GitHub → Settings → Developer settings → OAuth Apps.'
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
