/**
 * Per-user AI-provider credentials gate.
 *
 * The credential vault is enabled by default on every install: `getEncryptionKey()`
 * auto-provisions a local key (`~/.archon/credential-key`, 0600) on first use when
 * `TOKEN_ENCRYPTION_KEY` is not set. The explicit env var still wins where operators
 * set one (managed VPS / multi-user deployments). See `token-crypto.ts` for the
 * three-tier resolver chain.
 *
 * Note: this is independent of the per-user GitHub gate
 * (`packages/core/src/github-auth/config.ts`), which still requires both
 * `GITHUB_APP_ID` and `TOKEN_ENCRYPTION_KEY`.
 */
import { getEncryptionKey } from '../utils/token-crypto';

/**
 * True when per-user AI-provider credentials are active on this install — always,
 * because the encryption key is auto-provisioned. The `_env` param is retained for
 * signature compatibility with callers that pass an explicit env.
 */
export function isPerUserProviderKeysEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true;
}

/**
 * Fail fast at server boot: the encryption key must be resolvable and well-formed.
 * With the auto-key, `getEncryptionKey()` reads or generates the local key — so this
 * also warms the vault at boot. Throws only when `TOKEN_ENCRYPTION_KEY` is set but
 * malformed (a misconfigured deployment), never on a fresh solo install.
 */
export function assertProviderKeysKeyAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  getEncryptionKey(env);
}
