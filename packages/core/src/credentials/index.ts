/**
 * Per-user AI-provider credentials (Phase 2) — public surface.
 *
 * PR-1 (this PR) ships the foundation: gate + delivery map + encrypted store
 * + inject seams. PR-2 will add `connect-service` (persist API key / OAuth)
 * + route handlers; PR-3 will add `oauth-bridge` (Pi OAuth wrapper) and
 * flesh out the OAuth read path in the store.
 *
 * Until then, the symbols below are the stable contract: the gate, the
 * delivery map types, and the `KNOWN_PROVIDERS` set used to validate
 * provider ids at connect time.
 */
export { isPerUserProviderKeysEnabled, assertProviderKeysKeyAtBoot } from './config';
export {
  deliverCredential,
  KNOWN_PROVIDERS,
  type ResolvedCredential,
  type DeliveryResult,
  type DeliveryOptions,
  type OAuthCredentials,
} from './delivery';
