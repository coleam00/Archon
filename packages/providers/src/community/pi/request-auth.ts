/**
 * Minimal structural view of the pieces of Pi 0.83's `ModelRuntime` that the
 * credential boundary reads/overrides. Kept local (rather than importing the
 * SDK types) so this module stays a pure, side-effect-free helper — mirroring
 * how the pre-0.83 version modelled `AuthStorage` structurally.
 */
/** Structural view of pi-ai's `AuthResult` — only the fields we read/echo. */
interface RuntimeAuthResolution {
  auth?: { apiKey?: string; headers?: Record<string, string | null> };
  env?: Record<string, string>;
  source?: string;
}

interface RuntimeAuthBoundary {
  /** Overloaded on the SDK (providerId | Model); we only branch on `.provider`. */
  getAuth(
    providerOrModel: unknown,
    overrides?: { apiKey?: string; env?: Record<string, string>; minOAuthValidityMs?: number }
  ): Promise<RuntimeAuthResolution | undefined>;
  hasConfiguredAuth(providerId: string): boolean;
  listCredentials(): Promise<readonly { providerId: string }[]>;
}

/**
 * Give one custom provider access to request/project env without exposing values
 * injected by Archon as credentials.
 *
 * Pi 0.83 replaced the pre-0.83 `AuthStorage.getProviderEnv`/`hasAuth` surface
 * (which we used to monkey-patch) with `ModelRuntime`: request/project env is
 * resolved through `ModelRuntime.getAuth(model, { env })`, and configured-auth
 * status through `ModelRuntime.hasConfiguredAuth(providerId)`. So the boundary
 * is now enforced by wrapping the runtime rather than the auth store:
 *
 *  - `getAuth` overlays the (credential-filtered) request env for THIS provider.
 *    A protected key is a non-enumerable throwing getter, so Pi's resolver
 *    throws instead of falling through to `process.env` for that name — the
 *    same guarantee the pre-0.83 throwing-getter gave. Because 0.83's
 *    config-template resolution does not echo the input provider env into
 *    `AuthResult.env` (only stored-credential resolution does), we surface the
 *    resolved request env explicitly, matching the old `getProviderEnv` echo.
 *  - `hasConfiguredAuth` reports the provider as configured when request env
 *    supplies its config, matching the old `hasAuth` narrowing.
 *
 * The unmodified `ModelRegistry` facade (`hasConfiguredAuth`,
 * `getApiKeyAndHeaders`) reads straight through the wrapped runtime, so callers
 * need no further changes. The wrapper is created once per request, so
 * narrowing it cannot leak into another request.
 *
 * A provider that already owns a stored credential (auth.json) is returned
 * unwrapped: the stored credential wins and request env must not replace it.
 */
export async function withCustomProviderRequestEnv<T extends RuntimeAuthBoundary>(
  runtime: T,
  provider: string,
  requestEnv: Readonly<Record<string, string>> | undefined,
  protectedEnvKeys: readonly string[] | undefined
): Promise<T> {
  if (!requestEnv || Object.keys(requestEnv).length === 0) {
    return runtime;
  }

  // A stored credential owns the provider — don't overlay request env on it.
  const stored = await runtime.listCredentials();
  if (stored.some(entry => entry.providerId === provider)) {
    return runtime;
  }

  const credentialKeys = new Set(protectedEnvKeys);
  const providerEnv: Record<string, string> = Object.fromEntries(
    Object.entries(requestEnv).filter(([key]) => !credentialKeys.has(key))
  );

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

  const originalGetAuth = runtime.getAuth.bind(runtime);
  const originalHasConfiguredAuth = runtime.hasConfiguredAuth.bind(runtime);
  const hasRequestProviderEnv = Object.keys(providerEnv).length > 0;

  const overrides = {
    getAuth: async (
      providerOrModel: unknown,
      requestOverrides?: {
        apiKey?: string;
        env?: Record<string, string>;
        minOAuthValidityMs?: number;
      }
    ): Promise<RuntimeAuthResolution | undefined> => {
      const providerId =
        typeof providerOrModel === 'string'
          ? providerOrModel
          : (providerOrModel as { provider?: string } | null)?.provider;
      if (providerId !== provider) {
        return originalGetAuth(providerOrModel, requestOverrides);
      }
      // No caller-supplied env (the ModelRegistry facade path): hand Pi the
      // providerEnv object directly so its non-enumerable throwing getters stay
      // intact. With a caller env, layer providerEnv over it (protected getters
      // re-applied) so both channels compose without dropping the guard.
      const env = requestOverrides?.env
        ? layerProviderEnv(requestOverrides.env, requestEnv, credentialKeys, provider)
        : providerEnv;
      const resolution = await originalGetAuth(providerOrModel, { ...requestOverrides, env });
      // A credentialless custom provider (e.g. a local server) resolves to no
      // auth in 0.83, but must stay valid and still carry its project env — the
      // pre-0.83 getProviderEnv/hasAuth pair reported it configured. Surface an
      // auth-less resolution carrying the request env so the ModelRegistry
      // facade reports { ok: true, env } rather than a compatibility miss.
      if (!resolution) {
        return hasRequestProviderEnv ? { auth: {}, env: { ...providerEnv } } : resolution;
      }
      // Echo the request env (safe keys only — throwing getters are
      // non-enumerable, so the spread omits them) the way the pre-0.83
      // getProviderEnv did; a resolved value from the credential wins.
      return { ...resolution, env: { ...providerEnv, ...(resolution.env ?? {}) } };
    },
    hasConfiguredAuth: (providerId: string): boolean =>
      (providerId === provider && hasRequestProviderEnv) || originalHasConfiguredAuth(providerId),
  };

  return new Proxy(runtime, {
    get(target, prop, receiver): unknown {
      if (prop === 'getAuth') return overrides.getAuth;
      if (prop === 'hasConfiguredAuth') return overrides.hasConfiguredAuth;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Merge a caller-supplied request env with the credential-filtered provider env,
 * re-applying the non-enumerable throwing getters for protected keys so the
 * guard survives the merge.
 */
function layerProviderEnv(
  callerEnv: Record<string, string>,
  requestEnv: Readonly<Record<string, string>>,
  credentialKeys: ReadonlySet<string>,
  provider: string
): Record<string, string> {
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries({ ...callerEnv, ...requestEnv }).filter(([key]) => !credentialKeys.has(key))
  );
  for (const key of credentialKeys) {
    Object.defineProperty(merged, key, {
      configurable: false,
      enumerable: false,
      get(): never {
        throw new Error(
          `Custom Pi provider '${provider}' cannot access protected environment variable '${key}'`
        );
      },
    });
  }
  return merged;
}
