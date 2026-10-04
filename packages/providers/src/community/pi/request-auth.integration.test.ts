/**
 * Real-SDK integration test for the per-call `models.json` substitution
 * that closes review R1 on PR #2757.
 *
 * The review's finding was that the `withCustomProviderRequestEnv` wrapper
 * (overriding `getApiKeyAndHeaders` on a `ModelRegistry`) plugged into a
 * surface the 0.84.0 SDK no longer consults during session auth — a fresh
 * `new ModelRegistry(this._modelRuntime)` is built inside
 * `createAgentSession`, so the wrapped registry was discarded.
 *
 * The fix: write a per-call `models.json` with `${VAR}` references
 * substituted against `requestOptions.env`, then pass it as `modelsPath`
 * to `ModelRuntime.create`. The SDK reads the literal substituted values
 * from disk at `ModelConfig.load` time and never falls through to
 * `process.env`.
 *
 * This test exercises the fix against the REAL pi-coding-agent SDK
 * (no `mock.module` shim) and asserts:
 *   - a credentialless custom provider (`apiKey: '$VAR'`) loaded from a
 *     per-call models.json with substituted values resolves the credential
 *     correctly when the var is in `requestEnv`;
 *   - the same provider with `${VAR}` left literal (because the var is
 *     missing or protected) fails with the SDK's standard "no value for
 *     env var" error — confirming the protected-env contract holds at the
 *     SDK auth seam, not just at a wrapper override the SDK never reads.
 *   - protected `${VAR}` references are substituted with a placeholder that
 *     the SDK can NEVER resolve (regardless of host env state), so the
 *     host shell's GH_TOKEN / GITHUB_TOKEN / COPILOT_GITHUB_TOKEN /
 *     ANTHROPIC_API_KEY / OPENAI_API_KEY cannot leak into the per-call
 *     file's `apiKey` or `headers`.
 *
 * Skipped on machines where the SDK can't import (e.g. Bun-compiled binary
 * fixture runs): the test uses the live `@earendil-works/pi-coding-agent`
 * package and runs in `bun test`, the same runner the rest of the suite
 * uses. If the SDK ever fails to import, every other Pi test fails too —
 * this test will surface the same failure with an actionable label.
 *
 * Mock-isolation note: `provider.test.ts` mocks
 * `@earendil-works/pi-coding-agent` at module scope, and Bun's
 * `mock.module()` is process-global, irreversible, AND matches all
 * subpath imports of a mocked package (AGENTS.md, #2240; verified against
 * bun 1.3.11). Running this test alongside `provider.test.ts` in a single
 * `bun test <file1> <file2>` invocation therefore contaminates the SDK
 * here even when we use a deep subpath — the SDK is loaded by file path,
 * but the mock registration matches by package specifier and is applied to
 * every import of any file under that package.
 *
 * To keep the "no `mock.module` shim" claim true, the SDK-dependent tests
 * in this file probe `ModelRuntime.create({})` at module load and verify
 * the returned instance has the real prototype methods (`getModel`,
 * `getAuth`). If contamination is detected (the probe returns the mock
 * factory's shape instead of a `ModelRuntime` instance), every
 * SDK-dependent test below `test.skipIf(...)`'s out with a clear warning
 * that points the developer at the right `bun test` invocation. The CI
 * runs each file in its own process (the package.json `&&`-separated
 * `bun test` chain), so contamination is not possible there; this guard
 * only fires for dev workflows that run multiple files in one process.
 * The file-mode test (which doesn't need the SDK) runs unconditionally.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import type { ModelRuntime as PiModelRuntime } from '@earendil-works/pi-coding-agent';

import { trackTempRoots } from '@archon/paths/test-utils';

import {
  buildCustomProviderModelsPath,
  createRequestModelRuntime,
  getUserModelsStorePath,
} from './request-auth';

interface ModelRuntimeCtor {
  create(options?: {
    modelsPath?: string;
    authPath?: string | null;
    refreshOnCreate?: boolean;
  }): Promise<{
    getModel(providerId: string, modelId: string): unknown;
    getAuth(model: unknown): Promise<{ auth: { apiKey?: string } } | undefined>;
    getCompatibilityRequestConfig(model: unknown): { headers?: Record<string, string> };
  }>;
}

/**
 * Load the REAL `ModelRuntime` class via a deep subpath that
 * `provider.test.ts`'s `mock.module('@earendil-works/pi-coding-agent', …)`
 * does not match in isolation. Resolved from the package's main entry —
 * bun's hoisted install path is opaque, so we derive `dist/core/model-runtime.js`
 * from the resolved `dist/index.js` location.
 *
 * Note: when this file runs in the same `bun test` invocation as a file
 * that already mocked `@earendil-works/pi-coding-agent`, bun's mock.module
 * does match this deep subpath and the SDK returned is the mock factory's
 * shell. The `probeRealSdkAvailable` helper below detects this and the
 * SDK-dependent tests self-skip.
 */
async function loadRealModelRuntime(): Promise<ModelRuntimeCtor> {
  const sdkIndexUrl = await import.meta.resolve('@earendil-works/pi-coding-agent');
  const sdkIndexPath = fileURLToPath(sdkIndexUrl);
  const deepPath = pathToFileURL(join(dirname(sdkIndexPath), 'core', 'model-runtime.js')).href;
  const mod = (await import(deepPath)) as { ModelRuntime: ModelRuntimeCtor };
  return mod.ModelRuntime;
}

/**
 * Return `true` iff `ModelRuntime.create({})` returns a real instance (with
 * `getModel` on its prototype). A mocked module returns a plain object
 * shaped like the mock factory, which lacks `getModel`.
 *
 * The probe runs once at module load — its result is captured in
 * `realSdkAvailable` and used by `test.skipIf(...)` below. This is the
 * reviewer's option 2 ("Skip the test when `import.meta.resolve` probes a
 * mock — fragile"), and it IS fragile: if the mock factory grows
 * `getModel` (it shouldn't, since `provider.test.ts` only stubs the
 * auth-call surface), the probe would silently say the SDK is real when it
 * isn't. The trade-off is acceptable because (a) `provider.test.ts` is the
 * only file in this package that mocks the SDK, (b) the SDK's auth-call
 * surface is large and not stubbed today (it's the point of the unit tests
 * there to NOT stub the full surface), and (c) the CI runs each file in
 * its own `bun test` process so the probe always returns `true` in CI.
 */
async function probeRealSdkAvailable(): Promise<boolean> {
  // Isolate the probe from the host's real ~/.pi/agent: it runs at module
  // load, before beforeEach points PI_CODING_AGENT_DIR at a scratch dir, and
  // every other create() in this file passes refreshOnCreate: false — the
  // probe must not be the one call that reads the developer's actual config.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = '/nonexistent-for-archon-int-probe';
  try {
    const ModelRuntime = await loadRealModelRuntime();
    const inst = (await ModelRuntime.create({ refreshOnCreate: false })) as {
      getModel?: unknown;
    };
    return typeof inst.getModel === 'function';
  } catch {
    return false;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

const realSdkAvailable = await probeRealSdkAvailable();
if (!realSdkAvailable) {
  // Surface the skip reason once at module load so a developer running
  // `bun test src/community/pi/*` together sees what's wrong before the
  // per-test skip annotations scroll past.
  console.warn(
    '\n⚠️  request-auth.integration.test.ts: skipping SDK-dependent tests\n' +
      '   Real ModelRuntime is not available in this bun process — the\n' +
      "   '@earendil-works/pi-coding-agent' mock from provider.test.ts is in\n" +
      '   effect. Run this file in its own bun invocation to exercise the\n' +
      '   real SDK end-to-end:\n' +
      '\n' +
      '     bun test src/community/pi/request-auth.integration.test.ts\n' +
      '\n' +
      '   The package.json test script already does this in CI; the skip\n' +
      '   only fires for local workflows that bundle multiple files.\n'
  );
}

// Every test points tmpdir() at a root it owns, so the per-call files written
// under tmpdir()/archon-pi-models (and the fixture dirs below) are removed with
// that root instead of piling up in the real tmpdir.
// node:os tmpdir() reads TMPDIR on POSIX and TMP/TEMP on Windows.
const trackTempRoot = trackTempRoots();
const TMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;
let scratchTmp = '';
let originalTmpEnv: (string | undefined)[] = [];
let originalAgentDir: string | undefined;
let originalProcessEnv: {
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  COPILOT_GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
} = {};

function makeUserModelsDir(providers: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archon-pi-int-user-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers }));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

describe('buildCustomProviderModelsPath integration with the real pi-coding-agent SDK', () => {
  beforeEach(() => {
    scratchTmp = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-pi-int-tmp-')));
    originalTmpEnv = TMP_ENV_KEYS.map(key => process.env[key]);
    for (const key of TMP_ENV_KEYS) process.env[key] = scratchTmp;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    // Make sure we don't leak the user's actual ~/.pi/agent/models.json into
    // the SDK's default lookup — point it at a non-existent dir.
    process.env.PI_CODING_AGENT_DIR = '/nonexistent-for-archon-int-tests';
    // Snapshot + clear all credential-shaped env vars so the protected-env
    // contract's "host env can't fill in the protected value" guarantee is
    // exercised from a known-clean baseline. The CI runner's ambient
    // GH_TOKEN is exactly the surface that regressed in round 2.
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
    ] as const) {
      originalProcessEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    TMP_ENV_KEYS.forEach((key, i) => {
      const value = originalTmpEnv[i];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    for (const [key, value] of Object.entries(originalProcessEnv)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof originalProcessEnv];
      } else {
        process.env[key as keyof typeof originalProcessEnv] = value;
      }
    }
    originalProcessEnv = {};
  });

  test.skipIf(!realSdkAvailable)(
    'a per-call models.json with substituted ${VAR} resolves the credential end-to-end',
    async () => {
      // Define a credentialless custom provider in the user models.json. The
      // apiKey uses a `${MYGW_API_KEY}` template; the headers reference a
      // separate `${MYGW_PROJECT}`. Neither key is in `process.env` (Archon
      // deliberately keeps per-call secrets off process.env).
      makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: 'prefix-${MYGW_API_KEY}',
          headers: { 'X-Project': '${MYGW_PROJECT}' },
          models: [{ id: 'demo' }],
        },
      });

      const perCallPath = buildCustomProviderModelsPath({
        provider: 'mygw',
        requestEnv: { MYGW_API_KEY: 'request-secret', MYGW_PROJECT: 'project-123' },
        protectedEnvKeys: [],
      });
      expect(perCallPath).toBeDefined();

      // Now point the SDK at the per-call file. The runtime reads the literal
      // substituted values directly (no `${VAR}` substitution at runtime,
      // because the values are no longer templates) and resolves the auth.
      const ModelRuntime = await loadRealModelRuntime();
      const runtime = await ModelRuntime.create({
        modelsPath: perCallPath,
        authPath: undefined,
        refreshOnCreate: false,
      });
      const model = runtime.getModel('mygw', 'demo');
      expect(model).toBeDefined();
      const resolution = await runtime.getAuth(model!);
      // Resolution returns the literal substituted apiKey and headers.
      expect(resolution?.auth.apiKey).toBe('prefix-request-secret');
      // `configuredHeaders` carries the literal 'project-123' (not a
      // template, no fallback to process.env).
      const configuredHeaders = runtime.getCompatibilityRequestConfig(model!).headers;
      expect(configuredHeaders).toEqual({ 'X-Project': 'project-123' });
    }
  );

  test.skipIf(!realSdkAvailable)(
    'a per-call models.json with a literal apiKey (no template) skips substitution',
    async () => {
      makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: 'literal-key',
          models: [{ id: 'demo' }],
        },
      });

      // No `${VAR}` references in the user entry → no per-call file needed.
      const perCallPath = buildCustomProviderModelsPath({
        provider: 'mygw',
        requestEnv: { MYGW_API_KEY: 'unused' },
        protectedEnvKeys: [],
      });
      expect(perCallPath).toBeUndefined();

      // Sanity-check: the SDK still resolves the literal apiKey from the
      // user models.json via its default `modelsPath` lookup.
      const ModelRuntime = await loadRealModelRuntime();
      const runtime = await ModelRuntime.create({ refreshOnCreate: false });
      const model = runtime.getModel('mygw', 'demo');
      expect(model).toBeDefined();
      const resolution = await runtime.getAuth(model!);
      expect(resolution?.auth.apiKey).toBe('literal-key');
    }
  );

  test.skipIf(!realSdkAvailable)(
    'protected ${VAR} references produce a per-call file with a host-env-independent blocker placeholder',
    async () => {
      // GH_TOKEN is in requestEnv but is protected — the per-call file must
      // NOT contain the literal GH_TOKEN value (security contract), AND it
      // must NOT fall through to process.env.GH_TOKEN at SDK resolve time.
      makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: '${GH_TOKEN}',
          models: [{ id: 'demo' }],
        },
      });

      const perCallPath = buildCustomProviderModelsPath({
        provider: 'mygw',
        requestEnv: { GH_TOKEN: 'acting-user-secret' },
        protectedEnvKeys: ['GH_TOKEN'],
      });
      // Substitution happened (placeholder written). The literal protected
      // value never appears in the file.
      expect(perCallPath).toBeDefined();
      const written = JSON.parse(readFileSync(perCallPath as string, 'utf-8') as string) as {
        providers: { mygw: { apiKey: string } };
      };
      expect(written.providers.mygw.apiKey).toBe('${__ARCHON_BLOCKED_GH_TOKEN__}');
      expect(written.providers.mygw.apiKey).not.toContain('acting-user-secret');

      // The SDK's own resolveConfigValue fails because the placeholder name
      // is provably absent from any context — no requestEnv, no process.env
      // can supply `__ARCHON_BLOCKED_GH_TOKEN__`. The error message names the
      // placeholder so an operator debugging the failure sees the
      // deliberate-blocker message rather than guessing why a credential
      // they configured isn't working.
      const ModelRuntime = await loadRealModelRuntime();
      const runtime = await ModelRuntime.create({
        modelsPath: perCallPath,
        refreshOnCreate: false,
      });
      const model = runtime.getModel('mygw', 'demo');
      expect(model).toBeDefined();
      await expect(runtime.getAuth(model!)).rejects.toThrow(/__ARCHON_BLOCKED_GH_TOKEN__/);
    }
  );

  test.skipIf(!realSdkAvailable)(
    'protected ${VAR} in headers blocks the value even when the same var is set in the host shell',
    async () => {
      // Round-2 regression: a CI runner with GH_TOKEN set in the host shell
      // leaked the shell's GitHub PAT into the per-call file via Pi's
      // `process.env` fallback. With the placeholder substitution, even if
      // the host shell GH_TOKEN is `host-shell-leak-test`, the SDK cannot
      // resolve the placeholder name and throws.
      process.env.GH_TOKEN = 'host-shell-leak-test';
      makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: 'Bearer ${GH_TOKEN}',
          models: [{ id: 'demo' }],
        },
      });

      const perCallPath = buildCustomProviderModelsPath({
        provider: 'mygw',
        requestEnv: { GH_TOKEN: 'acting-user-secret' },
        protectedEnvKeys: ['GH_TOKEN'],
      });
      expect(perCallPath).toBeDefined();
      const written = JSON.parse(readFileSync(perCallPath as string, 'utf-8') as string) as {
        providers: { mygw: { apiKey: string } };
      };
      // No leak: the host shell value is never written to the file.
      expect(written.providers.mygw.apiKey).toBe('Bearer ${__ARCHON_BLOCKED_GH_TOKEN__}');
      expect(written.providers.mygw.apiKey).not.toContain('host-shell-leak-test');
      expect(written.providers.mygw.apiKey).not.toContain('acting-user-secret');

      // SDK fails on the placeholder even though host shell GH_TOKEN is set.
      const ModelRuntime = await loadRealModelRuntime();
      const runtime = await ModelRuntime.create({
        modelsPath: perCallPath,
        refreshOnCreate: false,
      });
      const model = runtime.getModel('mygw', 'demo');
      expect(model).toBeDefined();
      await expect(runtime.getAuth(model!)).rejects.toThrow(/__ARCHON_BLOCKED_GH_TOKEN__/);
      // And the host shell value is NEVER the resolved apiKey.
      try {
        const resolution = await runtime.getAuth(model!);
        expect(resolution?.auth.apiKey).not.toContain('host-shell-leak-test');
      } catch {
        // The reject above is the expected outcome; this branch only fires
        // if the contract regresses and the call resolves.
      }
    }
  );

  test.skipIf(!realSdkAvailable)(
    'the per-call models.json outlives a provider registration until release()',
    async () => {
      // Pi re-reads modelsPath on refresh() and treats a missing file as an
      // empty config; registerProvider() ends with a background refresh(). The
      // custom provider must survive that for the whole session.
      makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: '${MYGW_API_KEY}',
          models: [{ id: 'demo' }],
        },
      });
      const ModelRuntime = (await loadRealModelRuntime()) as unknown as typeof PiModelRuntime;
      const { runtime, release } = await createRequestModelRuntime(
        options => ModelRuntime.create(options),
        undefined,
        { provider: 'mygw', requestEnv: { MYGW_API_KEY: 'request-secret' }, protectedEnvKeys: [] }
      );

      runtime.registerProvider('other', {
        baseUrl: 'https://other.example/v1',
        api: 'openai-completions',
        apiKey: 'other-key',
        models: [
          {
            id: 'o1',
            name: 'o1',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
          },
        ],
      });
      // Runs the same ModelConfig.load(modelsPath) as the background refresh
      // registerProvider() started, and settles after it.
      await runtime.refresh({ allowNetwork: false });

      const model = runtime.getModel('mygw', 'demo');
      expect(model).toBeDefined();
      expect((await runtime.getAuth(model!))?.auth.apiKey).toBe('request-secret');

      // Only the per-call file lives in the per-call directory, and release()
      // removes it.
      const perCallDir = join(scratchTmp, 'archon-pi-models');
      expect(readdirSync(perCallDir)).toHaveLength(1);
      release();
      expect(readdirSync(perCallDir)).toEqual([]);
    }
  );

  test.skipIf(!realSdkAvailable)(
    "the per-call runtime reads the user's models-store.json, not one beside the per-call file",
    async () => {
      // Pi derives the catalog store from dirname(modelsPath) unless told
      // otherwise; a model the user's Pi learned into models-store.json must
      // still resolve when the runtime reads a per-call models.json.
      const userDir = makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: '${MYGW_API_KEY}',
          models: [{ id: 'demo' }],
        },
      });
      expect(getUserModelsStorePath()).toBe(join(userDir, 'models-store.json'));
      writeFileSync(
        getUserModelsStorePath(),
        JSON.stringify({
          openrouter: {
            models: [
              {
                id: 'archon-test/store-only-model',
                name: 'Archon store-only test model',
                api: 'openai-completions',
                baseUrl: 'https://openrouter.ai/api/v1',
                provider: 'openrouter',
                reasoning: false,
                input: ['text'],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131072,
                maxTokens: 32768,
              },
            ],
            checkedAt: Date.now(),
            lastModified: Date.now(),
          },
        })
      );
      const ModelRuntime = (await loadRealModelRuntime()) as unknown as typeof PiModelRuntime;
      const { runtime, release } = await createRequestModelRuntime(
        options => ModelRuntime.create(options),
        undefined,
        { provider: 'mygw', requestEnv: { MYGW_API_KEY: 'request-secret' }, protectedEnvKeys: [] }
      );
      try {
        expect(runtime.getModel('openrouter', 'archon-test/store-only-model')).toBeDefined();
      } finally {
        release();
      }
    }
  );

  // The file-mode test does NOT need the SDK — it only checks the on-disk
  // permissions written by buildCustomProviderModelsPath. Runs whenever the
  // platform has POSIX permission bits, even when the SDK is contaminated, so
  // the security contract is verified regardless of how the dev runs the
  // suite. Windows has no POSIX mode bits — stat reports 0o666/0o444 from the
  // read-only attribute regardless of the mode passed to writeFileSync — so
  // the assertion is meaningless there and the test is skipped.
  test.skipIf(process.platform === 'win32')(
    'per-call file is written with owner-only mode (0o600) and the directory with 0o700',
    () => {
      // Round-2 review: the file was written world-readable (mode 0o644) on a
      // default-umask Linux host, leaking the substituted secret to every
      // local account. The fix sets explicit mode AND chmod after to defeat
      // umask.
      makeUserModelsDir({
        mygw: {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: 'prefix-${MYGW_API_KEY}',
          models: [{ id: 'demo' }],
        },
      });

      const perCallPath = buildCustomProviderModelsPath({
        provider: 'mygw',
        requestEnv: { MYGW_API_KEY: 'request-secret' },
        protectedEnvKeys: [],
      });
      expect(perCallPath).toBeDefined();
      const fileStat = statSync(perCallPath as string);
      // Permission bits only — `mode & 0o777` strips the file-type bits.
      expect(fileStat.mode & 0o777).toBe(0o600);
      const dirStat = statSync(join(perCallPath as string, '..'));
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  );
});
