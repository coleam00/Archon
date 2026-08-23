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
 *
 * Skipped on machines where the SDK can't import (e.g. Bun-compiled binary
 * fixture runs): the test uses the live `@earendil-works/pi-coding-agent`
 * package and runs in `bun test`, the same runner the rest of the suite
 * uses. If the SDK ever fails to import, every other Pi test fails too —
 * this test will surface the same failure with an actionable label.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCustomProviderModelsPath } from './request-auth';

const createdDirs: string[] = [];
let originalAgentDir: string | undefined;

function makeUserModelsDir(providers: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archon-pi-int-user-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers }));
  createdDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

describe('buildCustomProviderModelsPath integration with the real pi-coding-agent SDK', () => {
  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    // Make sure we don't leak the user's actual ~/.pi/agent/models.json into
    // the SDK's default lookup — point it at a non-existent dir.
    process.env.PI_CODING_AGENT_DIR = '/nonexistent-for-archon-int-tests';
  });

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  });

  test('a per-call models.json with substituted ${VAR} resolves the credential end-to-end', async () => {
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
    const piCodingAgent = await import('@earendil-works/pi-coding-agent');
    const runtime = await piCodingAgent.ModelRuntime.create({
      modelsPath: perCallPath,
      authPath: undefined,
    });
    const model = runtime.getModel('mygw', 'demo');
    expect(model).toBeDefined();
    const resolution = await runtime.getAuth(model!);
    // Resolution returns the literal substituted apiKey and headers.
    expect(resolution?.auth.apiKey).toBe('prefix-request-secret');
    // `configuredHeaders` carries the literal 'project-123' (not a
    // template, no fallback to process.env).
    const configuredHeaders = await runtime.getCompatibilityRequestConfig(model!).headers;
    expect(configuredHeaders).toEqual({ 'X-Project': 'project-123' });
  });

  test('a per-call models.json with a literal apiKey (no template) skips substitution', async () => {
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
    const piCodingAgent = await import('@earendil-works/pi-coding-agent');
    const runtime = await piCodingAgent.ModelRuntime.create({});
    const model = runtime.getModel('mygw', 'demo');
    expect(model).toBeDefined();
    const resolution = await runtime.getAuth(model!);
    expect(resolution?.auth.apiKey).toBe('literal-key');
  });

  test('protected ${VAR} references stay unsubstituted in the per-call file', async () => {
    // GH_TOKEN is in requestEnv but is protected — the per-call file must
    // NOT contain the literal GH_TOKEN value (security contract).
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
    // Protected reference → no substitution → no per-call file.
    expect(perCallPath).toBeUndefined();

    // Sanity-check: the SDK's default `modelsPath` loads the user
    // models.json (containing `${GH_TOKEN}`), and the SDK's own
    // resolveConfigValue fails because GH_TOKEN is absent from
    // process.env (Archon kept it empty). The error message names the
    // env var the SDK couldn't resolve — exactly the contract the wrapper
    // used to enforce, just at a different layer.
    const piCodingAgent = await import('@earendil-works/pi-coding-agent');
    const runtime = await piCodingAgent.ModelRuntime.create({});
    const model = runtime.getModel('mygw', 'demo');
    expect(model).toBeDefined();
    await expect(runtime.getAuth(model!)).rejects.toThrow(/GH_TOKEN/);
  });
});
