/**
 * OpenCode credential-surface introspection (#1955).
 *
 * OpenCode's backend universe is the models.dev catalog, resolved by the
 * embedded server at runtime — there is no static list Archon could declare
 * (the registration carries `credentials: { kind: 'dynamic' }`). This module
 * proxies the embedded server's own introspection endpoints:
 *
 *   GET /provider       → full catalog (id, name, env var names, models) +
 *                         which providers are currently `connected`
 *   GET /provider/auth  → per-provider auth methods (oauth | api, labeled)
 *
 * Heavyweight by design: acquiring the embedded runtime starts the OpenCode
 * server if it isn't already running. Callers (the console settings card)
 * must hit this on demand — never from a passive settings-page load.
 *
 * Per-user limitation: OpenCode's auth store is server-global (`PUT
 * /auth/{id}` writes the shared auth.json), so `connected` reflects the
 * install, not the calling user.
 */
import { createLogger } from '@archon/paths';
import { acquireEmbeddedRuntime, releaseEmbeddedRuntime, type EmbeddedRuntime } from './runtime';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

/** One auth method an OpenCode provider supports. */
export interface OpencodeAuthMethod {
  type: 'oauth' | 'api';
  label: string;
}

/** One OpenCode backend provider, introspected from the embedded server. */
export interface OpencodeCredentialProvider {
  id: string;
  name: string;
  /** Env var names the provider reads its API key from. */
  env: string[];
  /** Whether the embedded server reports the provider as authenticated (install-wide). */
  connected: boolean;
  /** Number of models the catalog lists for this provider. */
  modelCount: number;
  authMethods: OpencodeAuthMethod[];
}

export interface OpencodeCredentialIntrospection {
  providers: OpencodeCredentialProvider[];
}

/** Minimal structural view of the SDK client's provider namespace. */
interface ProviderIntrospectionClient {
  provider?: {
    list(options?: Record<string, unknown>): Promise<{
      data?: {
        all?: { id: string; name: string; env: string[]; models: Record<string, unknown> }[];
        connected?: string[];
      };
    }>;
    auth(options?: Record<string, unknown>): Promise<{
      data?: Record<string, { type: 'oauth' | 'api'; label: string }[]>;
    }>;
  };
}

/**
 * Introspect OpenCode's provider catalog + auth state via the embedded server.
 * Starts the runtime if needed and releases the reference when done. Throws on
 * runtime/introspection failure — callers map it to a 503, never a silent [].
 */
export async function introspectOpencodeCredentials(
  signal?: AbortSignal
): Promise<OpencodeCredentialIntrospection> {
  const runtime: EmbeddedRuntime = await acquireEmbeddedRuntime(signal);
  try {
    const client = runtime.client as unknown as ProviderIntrospectionClient;
    if (!client.provider?.list || !client.provider.auth) {
      throw new Error(
        'Embedded OpenCode server does not expose provider introspection (SDK too old?)'
      );
    }
    const [listResult, authResult] = await Promise.all([
      client.provider.list(),
      client.provider.auth(),
    ]);
    // A structurally partial response (missing `data.all`) must surface as a
    // failure (→ 503 at the route), never as an empty-but-200 catalog. The
    // per-provider `authMethods[p.id] ?? []` fallback below is fine — a
    // provider without listed auth methods is a real upstream state.
    const all = listResult.data?.all;
    if (!Array.isArray(all)) {
      throw new Error(
        'Embedded OpenCode server returned a malformed provider list (missing data.all)'
      );
    }
    const connected = new Set(listResult.data?.connected ?? []);
    const authMethods = authResult.data ?? {};
    const providers = all
      .map(p => ({
        id: p.id,
        name: p.name,
        env: p.env ?? [],
        connected: connected.has(p.id),
        modelCount: Object.keys(p.models ?? {}).length,
        authMethods: authMethods[p.id] ?? [],
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    getLog().debug(
      { providerCount: providers.length, connectedCount: connected.size },
      'opencode.credential_introspection_completed'
    );
    return { providers };
  } finally {
    releaseEmbeddedRuntime(runtime);
  }
}
