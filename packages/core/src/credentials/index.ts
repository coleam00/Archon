/**
 * Per-user AI-provider credentials (Phase 2) — public surface.
 *
 * PR-1 shipped the foundation: gate + delivery map + encrypted store + inject
 * seams. PR-2 (this PR) adds `connect-service` (persist API key); PR-3 will add
 * `oauth-bridge` (Pi OAuth wrapper) and flesh out the OAuth read path.
 *
 * The symbols below are the stable contract: the gate, the delivery map types,
 * the `KNOWN_PROVIDERS` set used to validate provider ids at connect time, and
 * the API-key connect service.
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
export {
  persistProviderApiKey,
  InvalidProviderKeyError,
  type PersistProviderApiKeyResult,
} from './connect-service';
