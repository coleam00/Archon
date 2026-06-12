/**
 * Vendor catalog derived from provider registrations (#1955).
 *
 * The connectable-credential surface is the union of every registered agent's
 * `credentials` declaration — there is no hand-maintained list. Each entry
 * records which agents consume the vendor, powering the agent → credential
 * matrix in GET /api/auth/providers and the connect-time validation.
 *
 * Requires the provider registry to be bootstrapped
 * (registerBuiltinProviders + registerCommunityProviders) — all process
 * entrypoints do this before serving requests.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getRegisteredProviders,
  PI_PROVIDER_ENV_VARS,
  type CredentialKind,
} from '@archon/providers';
import { KNOWN_VENDORS, normalizeCredentialVendor } from './delivery';
import { SUBSCRIPTION_PROVIDERS } from './oauth-providers';

export interface VendorCatalogEntry {
  vendor: string;
  displayName: string;
  /** Union of kinds across all agents that declare this vendor. */
  kinds: CredentialKind[];
  /** Agent provider ids that consume this vendor. */
  agents: string[];
}

/**
 * Build the vendor catalog from the registry's static credential declarations.
 * Agents with a `dynamic` catalog (OpenCode) contribute nothing here — their
 * surface is resolved at runtime via their own introspection endpoint.
 *
 * Throws when a registration declares an `api_key` vendor the delivery map
 * cannot deliver — that is a registration bug and must fail loud, not surface
 * as a connect-then-silently-undeliverable credential.
 */
export function getVendorCatalog(): Map<string, VendorCatalogEntry> {
  const catalog = new Map<string, VendorCatalogEntry>();
  for (const reg of getRegisteredProviders()) {
    if (reg.credentials.kind !== 'static') continue;
    for (const spec of reg.credentials.specs) {
      const existing = catalog.get(spec.vendor);
      if (existing) {
        existing.agents.push(reg.id);
        for (const k of spec.kinds) {
          if (!existing.kinds.includes(k)) existing.kinds.push(k);
        }
      } else {
        catalog.set(spec.vendor, {
          vendor: spec.vendor,
          displayName: spec.displayName,
          kinds: [...spec.kinds],
          agents: [reg.id],
        });
      }
    }
  }
  for (const entry of catalog.values()) {
    if (entry.kinds.includes('api_key') && !KNOWN_VENDORS.has(entry.vendor)) {
      throw new Error(
        `Provider(s) ${entry.agents.join(', ')} declare credential vendor '${entry.vendor}' ` +
          '(api_key) but the delivery map has no rule for it.'
      );
    }
  }
  return catalog;
}

/** Sorted vendor ids a user can connect an API key for. */
export function listConnectableVendors(): string[] {
  return [...getVendorCatalog().values()]
    .filter(e => e.kinds.includes('api_key'))
    .map(e => e.vendor)
    .sort();
}

/** Whether `id` (vendor-canonical or legacy agent-keyed) is API-key connectable. */
export function isConnectableVendor(id: string): boolean {
  const entry = getVendorCatalog().get(normalizeCredentialVendor(id));
  return !!entry && entry.kinds.includes('api_key');
}

// ---- Agent → credential matrix (GET /api/auth/providers `agents`) ----------

/**
 * One credential a given agent consumes, with connection/detection state.
 * Hand-synced with `agentCredentialStatusSchema` in
 * `@archon/server/routes/schemas/provider-key.schemas.ts` (core can't own
 * route schemas) — update both together.
 */
export interface AgentCredentialStatus {
  vendor: string;
  displayName: string;
  kinds: CredentialKind[];
  /** The calling user's stored connection for this vendor, or null. */
  connected: 'api_key' | 'oauth' | null;
  /** Whether subscription (OAuth) login is currently connectable (gates included). */
  subscriptionAvailable: boolean;
  /** Whether the server process env already carries this vendor's key. */
  installEnv: boolean;
  /** Ambient chains only: detected in the server environment. */
  ambientConfigured?: boolean;
}

/**
 * One agent's credential surface + readiness.
 * Hand-synced with `agentCredentialsSchema` in
 * `@archon/server/routes/schemas/provider-key.schemas.ts` — update both together.
 */
export interface AgentCredentialMatrixEntry {
  id: string;
  displayName: string;
  catalog: 'static' | 'dynamic';
  /**
   * Whether at least one credential is usable (connected, present in the
   * install env, or ambient-detected). Always false for `dynamic` agents —
   * their surface is only knowable from their own runtime introspection.
   */
  ready: boolean;
  credentials: AgentCredentialStatus[];
}

/**
 * Extra env vars (beyond the vendor's API-key var) whose presence means the
 * install env already authenticates the vendor.
 */
const EXTRA_INSTALL_ENV_VARS: Record<string, string[]> = {
  // CLAUDE_API_KEY: read by the native Claude provider (and set by Archon's
  // own anthropic api_key delivery) — an install configured with only this
  // var is authenticated.
  anthropic: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
};

function hasInstallEnv(vendor: string): boolean {
  const vars = [
    ...(PI_PROVIDER_ENV_VARS[vendor] ? [PI_PROVIDER_ENV_VARS[vendor]] : []),
    ...(EXTRA_INSTALL_ENV_VARS[vendor] ?? []),
  ];
  return vars.some(v => !!process.env[v]);
}

/**
 * Ambient cloud-credential detection (status-only, mirrors pi-ai's
 * env-api-keys logic). Never reads or returns secret values.
 */
function isAmbientConfigured(vendor: string): boolean {
  if (vendor === 'amazon-bedrock') {
    return !!(
      process.env.AWS_PROFILE ||
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    );
  }
  if (vendor === 'google-vertex') {
    const adcPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    const hasAdc = existsSync(adcPath);
    const hasProject = !!(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT);
    const hasLocation = !!process.env.GOOGLE_CLOUD_LOCATION;
    return hasAdc && hasProject && hasLocation;
  }
  return false;
}

/**
 * Build the per-agent credential matrix for the grouped
 * GET /api/auth/providers response. `connections` is the calling user's stored
 * credential metadata (no secrets); pass [] when per-user keys are disabled —
 * install-env and ambient detection still populate readiness.
 */
export function buildAgentCredentialMatrix(
  connections: { provider: string; kind: 'api_key' | 'oauth' }[]
): AgentCredentialMatrixEntry[] {
  const connectedByVendor = new Map<string, 'api_key' | 'oauth'>(
    connections.map(c => [normalizeCredentialVendor(c.provider), c.kind])
  );
  return getRegisteredProviders().map(reg => {
    if (reg.credentials.kind !== 'static') {
      return {
        id: reg.id,
        displayName: reg.displayName,
        catalog: 'dynamic' as const,
        ready: false,
        credentials: [],
      };
    }
    const credentials = reg.credentials.specs.map(spec => {
      const ambient = spec.kinds.includes('ambient');
      const status: AgentCredentialStatus = {
        vendor: spec.vendor,
        displayName: spec.displayName,
        kinds: spec.kinds,
        connected: connectedByVendor.get(spec.vendor) ?? null,
        subscriptionAvailable:
          spec.kinds.includes('subscription') && SUBSCRIPTION_PROVIDERS.has(spec.vendor),
        installEnv: hasInstallEnv(spec.vendor),
      };
      if (ambient) status.ambientConfigured = isAmbientConfigured(spec.vendor);
      return status;
    });
    return {
      id: reg.id,
      displayName: reg.displayName,
      catalog: 'static' as const,
      ready: credentials.some(s => s.connected !== null || s.installEnv || s.ambientConfigured),
      credentials,
    };
  });
}
