/**
 * Per-user AI-provider credentials (Phase 2) — public surface.
 *
 * PR-1: gate + delivery map + encrypted store + inject seams. PR-2: API-key
 * connect. PR-3: the subscription `oauth-bridge` + the OAuth read path (refresh
 * on read). #1955: vendor-canonical ids + the registry-derived vendor catalog.
 * The symbols below are the stable contract: gate, delivery map types, the
 * vendor catalog, the connect services, and the OAuth bridge.
 */
export { isPerUserProviderKeysEnabled, assertProviderKeysKeyAtBoot } from './config';
export {
  deliverCredential,
  buildPiAuthJson,
  KNOWN_VENDORS,
  LEGACY_VENDOR_ALIASES,
  normalizeCredentialVendor,
  PI_AUTH_JSON_RELATIVE_PATH,
  PI_AUTH_PATH_ENV,
  type ResolvedCredential,
  type DeliveryResult,
  type DeliveryOptions,
  type OAuthCredentials,
} from './delivery';
export {
  getVendorCatalog,
  listConnectableVendors,
  isConnectableVendor,
  buildAgentCredentialMatrix,
  type VendorCatalogEntry,
  type AgentCredentialStatus,
  type AgentCredentialMatrixEntry,
} from './catalog';
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
  OAuthCallbackPortBusyError,
  type StartOAuthResult,
  type PollOAuthResult,
} from './oauth-bridge';
