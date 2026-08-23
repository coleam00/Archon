import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withCustomProviderRequestEnv } from './request-auth';

// pi 0.84.0+ ships `ModelRuntime` (the prior `AuthStorage.inMemory` factory
// was a `getCredential`-only surface; `ModelRuntime.create()` now drives
// credential lifecycle). We exercise the wrapper's two overridden methods
// (`getApiKeyAndHeaders`, `hasConfiguredAuth`) against a minimal hand-rolled
// runtime + registry pair — the test asserts the wrapper's contract, not
// the SDK's. The wrapper consults `registry.hasConfiguredAuth(model)` to
// decide whether the scoped provider has a STORED credential and skips
// the request-env override when it does (matches the pre-0.84 behavior
// where the stored credential's own `env` block always won over the
// per-request scope).

interface FakeRuntime {
  getAuth: (
    provider: string,
    options?: { env?: Record<string, string> }
  ) => Promise<
    | {
        auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
        env?: Record<string, string>;
      }
    | undefined
  >;
}

interface FakeRegistry {
  hasConfiguredAuth(model: { provider: string }): boolean;
  getApiKeyAndHeaders(model: { provider: string; id: string }): Promise<{
    ok: boolean;
    apiKey?: string;
    env?: Record<string, string>;
    error?: string;
  }>;
}

/** Per-test mutable state: the apiKey template written to models.json. */
let currentApiKeyTemplate: string | undefined;
/** Per-test: env that the (faked) ModelRuntime reads credentials from. */
let fileEnv: Record<string, string> = {};

function makeRuntime(): FakeRuntime {
  return {
    getAuth: async (_provider, options) => {
      // The (faked) ModelRuntime reads the stored credential from `fileEnv`
      // and substitutes the apiKey template's `${VAR}` references using
      // `options.env` if supplied (mirroring the SDK's behavior). If a
      // stored credential's `env` block exists, its keys WIN over the
      // override env — only keys NOT in the credential's env fall back to
      // the override. The wrapper's contract is: when `hasConfiguredAuth`
      // returns true, the request env is NOT merged (the stored env wins
      // entirely); when false, the request env IS used (the credentialless
      // provider config path).
      //
      // CRITICAL: preserve the throwing-getter semantics on the override
      // env. The wrapper builds `providerEnv` with non-enumerable throwing
      // properties for protected keys (Object.defineProperty). A naive
      // `{...env}` spread WOULD mask those getters behind primitive values,
      // losing the security contract the test verifies.
      const stored = { ...fileEnv };
      const overrideEnv = options?.env;
      if (!currentApiKeyTemplate) return undefined;
      const substituted = currentApiKeyTemplate.replace(/\$\{?([A-Z_]+)\}?/g, (_match, name) => {
        // Stored env first; override env only consulted if the key isn't in
        // stored. Reading the override env goes through `in`/`[]` so the
        // throwing getter fires if the property is a throwing one.
        if (name in stored) return stored[name];
        if (overrideEnv && name in overrideEnv) return overrideEnv[name];
        return '';
      });
      // Mirror the SDK's contract: `resolution.env` is the merged
      // credential+ambient context. Build the merged env here (override on
      // top of stored, but reading keys through `in`/`[]` so the throwing
      // getter fires for protected keys).
      const mergedEnv: Record<string, string> = {};
      for (const k of Object.keys(stored)) mergedEnv[k] = stored[k];
      if (overrideEnv) {
        for (const k of Object.keys(overrideEnv)) {
          if (!(k in mergedEnv)) mergedEnv[k] = overrideEnv[k];
        }
      }
      return { auth: { apiKey: substituted }, env: mergedEnv };
    },
  };
}

const createdDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalCopilotToken = process.env.COPILOT_GITHUB_TOKEN;

function createAgentDir(apiKey?: string, headers?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archon-pi-models-'));
  const provider: Record<string, unknown> = {
    baseUrl: 'https://gateway.example/v1',
    api: 'openai-completions',
    models: [{ id: 'demo' }],
  };
  if (apiKey !== undefined) provider.apiKey = apiKey;
  if (headers !== undefined) provider.headers = headers;
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mygw: provider } }));
  createdDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  currentApiKeyTemplate = apiKey;
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('withCustomProviderRequestEnv', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    restoreEnv('PI_CODING_AGENT_DIR', originalAgentDir);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey);
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
    restoreEnv('GH_TOKEN', originalGhToken);
    restoreEnv('GITHUB_TOKEN', originalGithubToken);
    restoreEnv('COPILOT_GITHUB_TOKEN', originalCopilotToken);
    currentApiKeyTemplate = undefined;
    fileEnv = {};
  });

  test('lets Pi resolve custom provider config from request/project env', async () => {
    createAgentDir('prefix-${MYGW_API_KEY}', { 'X-Project': '$MYGW_PROJECT' });
    fileEnv = {}; // no stored credential — the request env is the only source
    const runtime = makeRuntime();
    const registry: FakeRegistry = {
      hasConfiguredAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'from-base' }),
    };
    const wrapped = withCustomProviderRequestEnv(
      registry as unknown as never,
      runtime as unknown as never,
      {
        provider: 'mygw',
        requestEnv: {
          MYGW_API_KEY: 'request-secret',
          MYGW_PROJECT: 'project-123',
        },
        protectedEnvKeys: [],
      }
    ) as unknown as FakeRegistry;

    // hasConfiguredAuth: scoped provider with non-empty request-env sees true.
    expect(wrapped.hasConfiguredAuth({ provider: 'mygw' })).toBe(true);
    // Non-scoped provider: falls through to the base registry.
    expect(wrapped.hasConfiguredAuth({ provider: 'anthropic' })).toBe(false);
    // getApiKeyAndHeaders: scoped provider sees the request-env resolution.
    expect(await wrapped.getApiKeyAndHeaders({ provider: 'mygw', id: 'demo' })).toEqual({
      ok: true,
      apiKey: 'prefix-request-secret',
      env: {
        MYGW_API_KEY: 'request-secret',
        MYGW_PROJECT: 'project-123',
      },
    });
    // Non-scoped provider: base registry behavior (unchanged).
    expect(await wrapped.getApiKeyAndHeaders({ provider: 'anthropic', id: 'claude' })).toEqual({
      ok: true,
      apiKey: 'from-base',
    });
  });

  test.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'COPILOT_GITHUB_TOKEN',
  ])(
    'does not expose protected %s to custom provider config or process fallback',
    credentialEnvKey => {
      createAgentDir(`$${credentialEnvKey}`);
      fileEnv = {};
      const runtime = makeRuntime();
      const registry: FakeRegistry = {
        hasConfiguredAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'from-base' }),
      };
      const wrapped = withCustomProviderRequestEnv(
        registry as unknown as never,
        runtime as unknown as never,
        {
          provider: 'mygw',
          requestEnv: { [credentialEnvKey]: 'acting-user-secret' },
          protectedEnvKeys: [credentialEnvKey],
        }
      ) as unknown as FakeRegistry;

      // getApiKeyAndHeaders must surface the throwing-getter error as the
      // `ok: false` payload so Pi's downstream code path treats it as a
      // config-protected access (matching the pre-0.84 behavior).
      return wrapped.getApiKeyAndHeaders({ provider: 'mygw', id: 'demo' }).then(result => {
        expect(result).toEqual({
          ok: false,
          error: `Custom Pi provider 'mygw' cannot access protected environment variable '${credentialEnvKey}'`,
        });
      });
    }
  );

  test('does not replace stored custom-provider auth or its provider env', async () => {
    // When the provider has BOTH a stored credential env AND a request env,
    // the stored credential's `env` block must win (the regression that
    // the assessment called out — request env must NEVER downgrade a stored
    // OAuth credential's own env keys).
    createAgentDir('$MYGW_API_KEY');
    fileEnv = { MYGW_API_KEY: 'stored-secret' }; // stored credential env wins
    const storedApiKey = 'stored-secret';
    const runtime = makeRuntime();
    const registry: FakeRegistry = {
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'from-base', env: {} }),
    };
    const wrapped = withCustomProviderRequestEnv(
      registry as unknown as never,
      runtime as unknown as never,
      {
        provider: 'mygw',
        requestEnv: { MYGW_API_KEY: 'request-secret' },
        protectedEnvKeys: [],
      }
    ) as unknown as FakeRegistry;

    // hasConfiguredAuth stays true (base registry says so).
    expect(wrapped.hasConfiguredAuth({ provider: 'mygw' })).toBe(true);
    // Resolution uses the stored credential — apiKey is `stored-secret`
    // (NOT the request env's `request-secret`).
    const result = await wrapped.getApiKeyAndHeaders({ provider: 'mygw', id: 'demo' });
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(storedApiKey);
  });

  test('keeps credentialless custom providers valid', async () => {
    // provider has no `apiKey` in models.json — Pi's resolve path returns
    // `undefined` from `runtime.getAuth`, the wrapper falls back to the base
    // registry's compatibility fallback. The custom provider remains
    // resolvable.
    createAgentDir();
    fileEnv = {};
    const runtime = makeRuntime();
    const registry: FakeRegistry = {
      hasConfiguredAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'from-base' }),
    };
    const wrapped = withCustomProviderRequestEnv(
      registry as unknown as never,
      runtime as unknown as never,
      {
        provider: 'mygw',
        requestEnv: { PROJECT_SETTING: 'value' },
        protectedEnvKeys: [],
      }
    ) as unknown as FakeRegistry;

    expect(wrapped.hasConfiguredAuth({ provider: 'mygw' })).toBe(true);
    // The runtime returns undefined for `mygw` (no apiKey template), so the
    // wrapper falls back to the base registry's getApiKeyAndHeaders.
    expect(await wrapped.getApiKeyAndHeaders({ provider: 'mygw', id: 'demo' })).toEqual({
      ok: true,
      apiKey: 'from-base',
    });
  });
});
