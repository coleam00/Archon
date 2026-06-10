/**
 * Per-user AI-provider credentials gate (Phase 2).
 *
 * Mirrors the per-user GitHub gate (`packages/core/src/github-auth/config.ts`)
 * but is simpler: there is no equivalent of the GitHub App, so the feature is
 * active whenever `TOKEN_ENCRYPTION_KEY` is set. Solo / no-key installs see
 * every code path as a no-op (connect routes return 503, the workflow inject
 * is skipped, the orchestrator chat env is unchanged).
 */
import { getEncryptionKey } from '../utils/token-crypto';

/** True when per-user AI-provider credentials are active on this install. */
export function isPerUserProviderKeysEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TOKEN_ENCRYPTION_KEY);
}

/**
 * Fail fast at server boot: when per-user provider keys are enabled, the
 * encryption key must be present and well-formed. `getEncryptionKey()` throws
 * otherwise, so a misconfigured deployment never silently stores
 * unencryptable secrets.
 */
export function assertProviderKeysKeyAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  if (isPerUserProviderKeysEnabled(env)) {
    getEncryptionKey(env);
  }
}
