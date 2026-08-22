import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

import { withCustomProviderRequestEnv } from './request-auth';

// 0.83.0: the pre-0.83 monkey-patch on AuthStorage.getProviderEnv/hasAuth is
// gone. withCustomProviderRequestEnv now wraps the ModelRuntime, and the
// unmodified ModelRegistry facade (find/hasConfiguredAuth/getApiKeyAndHeaders)
// reads through it. ModelRuntime.create() loads models.json + auth.json from
// PI_CODING_AGENT_DIR, so each case writes a temp agent dir and builds a real
// runtime — exercising the actual pi-ai credential resolution, not a stub.

const createdDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalCopilotToken = process.env.COPILOT_GITHUB_TOKEN;

type StoredAuth = Record<string, { type: 'api_key'; key?: string; env?: Record<string, string> }>;

function createAgentDir(options?: {
  apiKey?: string;
  headers?: Record<string, string>;
  auth?: StoredAuth;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'archon-pi-models-'));
  const provider: Record<string, unknown> = {
    baseUrl: 'https://gateway.example/v1',
    api: 'openai-completions',
    models: [{ id: 'demo' }],
  };
  if (options?.apiKey !== undefined) provider.apiKey = options.apiKey;
  if (options?.headers !== undefined) provider.headers = options.headers;
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mygw: provider } }));
  if (options?.auth) writeFileSync(join(dir, 'auth.json'), JSON.stringify(options.auth));
  createdDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

/** Build a request-env-bounded ModelRegistry the way the Pi provider does. */
async function boundedRegistry(
  requestEnv: Record<string, string>,
  protectedEnvKeys: readonly string[]
): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create();
  const bounded = await withCustomProviderRequestEnv(runtime, 'mygw', requestEnv, protectedEnvKeys);
  return new ModelRegistry(bounded);
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
  });

  test('lets Pi resolve custom provider config from request/project env', async () => {
    createAgentDir({ apiKey: 'prefix-${MYGW_API_KEY}', headers: { 'X-Project': '$MYGW_PROJECT' } });
    const registry = await boundedRegistry(
      { MYGW_API_KEY: 'request-secret', MYGW_PROJECT: 'project-123' },
      []
    );

    const model = registry.find('mygw', 'demo');
    expect(model).toBeDefined();
    expect(registry.hasConfiguredAuth(model!)).toBe(true);
    const resolved = await registry.getApiKeyAndHeaders(model!);

    expect(resolved).toEqual({
      ok: true,
      apiKey: 'prefix-request-secret',
      headers: { 'X-Project': 'project-123' },
      env: {
        MYGW_API_KEY: 'request-secret',
        MYGW_PROJECT: 'project-123',
      },
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
    async credentialEnvKey => {
      process.env[credentialEnvKey] = 'process-secret';
      createAgentDir({ apiKey: `$${credentialEnvKey}` });
      const registry = await boundedRegistry({ [credentialEnvKey]: 'acting-user-secret' }, [
        credentialEnvKey,
      ]);

      const model = registry.find('mygw', 'demo');
      expect(model).toBeDefined();
      expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
        ok: false,
        error: `Custom Pi provider 'mygw' cannot access protected environment variable '${credentialEnvKey}'`,
      });
    }
  );

  test('does not replace stored custom-provider auth or its provider env', async () => {
    createAgentDir({
      apiKey: '$MYGW_API_KEY',
      auth: {
        mygw: {
          type: 'api_key',
          key: '$MYGW_API_KEY',
          env: { MYGW_API_KEY: 'stored-secret' },
        },
      },
    });
    const runtime = await ModelRuntime.create();
    // A stored credential owns the provider — the wrapper returns it unchanged.
    const bounded = await withCustomProviderRequestEnv(
      runtime,
      'mygw',
      { MYGW_API_KEY: 'request-secret' },
      []
    );
    expect(bounded).toBe(runtime);
    const registry = new ModelRegistry(bounded);

    const model = registry.find('mygw', 'demo');
    expect(model).toBeDefined();
    expect(registry.hasConfiguredAuth(model!)).toBe(true);
    // Stored env wins; the request-secret must not replace it.
    expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
      ok: true,
      apiKey: 'stored-secret',
      env: { MYGW_API_KEY: 'stored-secret' },
    });
  });

  test('keeps credentialless custom providers valid', async () => {
    createAgentDir();
    const registry = await boundedRegistry({ PROJECT_SETTING: 'value' }, []);

    const model = registry.find('mygw', 'demo');
    expect(model).toBeDefined();
    expect(registry.hasConfiguredAuth(model!)).toBe(true);
    expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
      ok: true,
      apiKey: undefined,
      env: { PROJECT_SETTING: 'value' },
    });
  });
});
