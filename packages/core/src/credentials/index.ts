/**
 * Per-user AI-provider credentials (Phase 2) — public surface.
 *
 * PR-1: gate + delivery map + encrypted store + inject seams. PR-2: API-key
 * connect. PR-3: the subscription `oauth-bridge` + the OAuth read path (refresh
 * on read). The symbols below are the stable contract: gate, delivery map types,
 * `KNOWN_PROVIDERS`, the connect services, and the OAuth bridge.
 */
export { isPerUserProviderKeysEnabled, assertProviderKeysKeyAtBoot } from './config';
export {
  deliverCredential,
  buildPiAuthJson,
  KNOWN_PROVIDERS,
  PI_AUTH_JSON_RELATIVE_PATH,
  PI_AUTH_PATH_ENV,
  type ResolvedCredential,
  type DeliveryResult,
  type DeliveryOptions,
  type OAuthCredentials,
} from './delivery';
export {
  persistProviderApiKey,
  persistProviderOAuth,
  InvalidProviderKeyError,
  type PersistProviderApiKeyResult,
  type PersistProviderOAuthResult,
} from './connect-service';
export { SUBSCRIPTION_PROVIDERS, ARCHON_TO_PI_OAUTH, piOAuthProviderFor } from './oauth-providers';
export {
  startOAuth,
  pollOAuth,
  cancelOAuth,
  type StartOAuthResult,
  type PollOAuthResult,
} from './oauth-bridge';
