/**
 * Provider-environment scope for one Pi request.
 *
 * The pre-0.84 helper wrapped an `AuthStorage` and mutated `getProviderEnv`
 * and `hasAuth` so a custom provider's `$VAR` resolution read the request's
 * env instead of any ambient source. 0.84.0 collapsed AuthStorage into
 * `ModelRuntime`; the SDK now passes per-call env to `runtime.getAuth(model,
 * { env })`. The replacement wraps a `ModelRegistry` and overrides the one
 * surface that reads request-time env (its `getApiKeyAndHeaders(model)`)
 * with a scoped variant for the targeted provider. All other providers
 * continue to see the underlying registry's behavior.
 *
 * Protected keys (those listed in `protectedEnvKeys`) are still kept out of
 * the scoped env: they're defined as throwing non-enumerable properties on
 * the env object, so any `$VAR` substitution that reads them raises the same
 * message as before.
 */
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface ProviderEnvRequestScope {
  provider: string;
  requestEnv: Readonly<Record<string, string>> | undefined;
  protectedEnvKeys: readonly string[] | undefined;
}

export function withCustomProviderRequestEnv(
  registry: ModelRegistry,
  runtime: ModelRuntime,
  scope: ProviderEnvRequestScope
): ModelRegistry {
  const { provider, requestEnv, protectedEnvKeys } = scope;
  if (requestEnv === undefined) return registry;

  const credentialKeys = new Set(protectedEnvKeys ?? []);
  const providerEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestEnv)) {
    if (!credentialKeys.has(key)) providerEnv[key] = value;
  }

  // A non-enumerable throwing property prevents Pi's resolver from falling
  // through to process.env for a protected name, while keeping protected values
  // out of the environment object later passed to the model request.
  for (const key of credentialKeys) {
    Object.defineProperty(providerEnv, key, {
      configurable: false,
      enumerable: false,
      get(): never {
        throw new Error(
          `Custom Pi provider '${provider}' cannot access protected environment variable '${key}'`
        );
      },
    });
  }

  // Forward every method on the original registry, overriding the two whose
  // semantics depend on the per-request env: `getApiKeyAndHeaders` (the
  // SDK's credential resolver for a model) and `hasConfiguredAuth`
  // (status-only check used by `createAgentSession` to fail fast on missing
  // creds). Behavior differs only when `model.provider === scope.provider`;
  // every other provider keeps its ambient resolution (file auth.json +
  // process.env).
  return Object.assign(Object.create(registry) as ModelRegistry, {
    hasConfiguredAuth: (m: Model<Api>) => {
      if (m.provider !== provider) return registry.hasConfiguredAuth(m);
      return Object.keys(providerEnv).length > 0 || registry.hasConfiguredAuth(m);
    },
    getApiKeyAndHeaders: async (m: Model<Api>) => {
      if (m.provider !== provider) return registry.getApiKeyAndHeaders(m);
      // The pre-0.84 helper mutated `authStorage.getProviderEnv` to return
      // the request env for the scoped provider; Pi's credential resolver
      // read template `${VAR}` references from the CREDENTIAL's own `env`
      // block, NOT from `getProviderEnv`. So a stored credential with
      // `key: '$VAR'` + `env: { VAR: 'stored' }` resolved to `'stored'` and
      // the request env was only consulted when the model had no stored
      // credential at all (the credentialless fallback path).
      //
      // pi 0.84.0+: `runtime.getAuth(model, { env })` MERGES `overrides.env`
      // into whatever the file-backed credential carries — passing the
      // request env unconditionally would clobber the stored credential's
      // own env and silently downgrade the model. Match the pre-0.84
      // behavior by only passing the override when no stored credential
      // exists for the provider.
      const hasStored = registry.hasConfiguredAuth(m);
      try {
        const resolution = await runtime.getAuth(m, hasStored ? undefined : { env: providerEnv });
        if (!resolution) {
          // No credential: fall back to the underlying registry, which
          // applies the SDK's compatibility fallback (baseUrl/headers
          // from models.json). This is the path credentialless custom
          // providers (LM Studio / ollama) take.
          return await registry.getApiKeyAndHeaders(m);
        }
        return {
          ok: true as const,
          apiKey: resolution.auth.apiKey,
          headers: resolution.auth.headers,
          ...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
          env: resolution.env,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  }) as ModelRegistry;
}
