import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type * as Pi from '@earendil-works/pi-coding-agent';
import { removeTempTree } from '@archon/paths/test-utils';
import { createRequestModelRuntime } from './request-auth';

const root = await mkdtemp(join(tmpdir(), 'pi-auth-boundary-'));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
afterAll(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await removeTempTree(root);
});
const { ModelRuntime } = (await import(
  pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
      'core/model-runtime.js'
    )
  ).href
)) as { ModelRuntime: typeof Pi.ModelRuntime };

for (const authoritative of [false, true]) {
  test(`real Pi auth preserves ${authoritative ? 'delivered identity' : 'native configuration'} and non-auth headers`, async () => {
    const authPath = join(root, 'auth.json');
    await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: 'user-key' } }));
    await writeFile(
      join(root, 'models.json'),
      `\uFEFF// native JSONC configuration\n${JSON.stringify(
        {
          providers: {
            anthropic: {
              apiKey: 'host-key',
              headers: {
                Authorization: 'Bearer host',
                'x-api-key': 'host',
                'X-Project': 'kept',
                'X-Syntax': 'quoted,} and ,] with "quotes" // and /* text */',
              },
              models: [
                {
                  id: 'custom-model',
                  headers: {
                    Authorization: 'Bearer custom-host',
                    'x-api-key': 'custom-host',
                    'X-Model': 'kept',
                  },
                },
              ],
              modelOverrides: {
                'claude-sonnet-4-5': {
                  headers: { AUTHORIZATION: 'Bearer model-host', 'X-Model': 'kept' },
                },
              },
            },
            openai: { baseUrl: 'https://example.invalid' },
          },
        },
        null,
        2
      ).replace(/\n(\s*[}\]])/g, ',\n$1')}`
    );
    const { runtime, release } = await createRequestModelRuntime(
      options => ModelRuntime.create({ ...options, refreshOnCreate: false }),
      authPath,
      authoritative
        ? {
            provider: 'anthropic',
            env: {},
            protectedEnvKeys: ['ARCHON_PI_AUTH_PATH'],
            authoritativeCredential: true,
          }
        : undefined
    );
    try {
      await runtime.refresh({ allowNetwork: false });
      for (const modelId of ['claude-sonnet-4-5', 'custom-model']) {
        const model = runtime.getModel('anthropic', modelId);
        expect(model).toBeDefined();
        if (!model) throw new Error('missing model');
        const result = await runtime.getAuth(model);
        expect(result?.auth.apiKey).toBe('user-key');
        const headers = result?.auth.headers ?? {};
        expect(headers['X-Project']).toBe('kept');
        expect(headers['X-Syntax']).toBe('quoted,} and ,] with "quotes" // and /* text */');
        expect(headers['X-Model']).toBe('kept');
        const authHeaders = Object.keys(headers).filter(name =>
          ['authorization', 'x-api-key'].includes(name.toLowerCase())
        );
        if (authoritative) expect(authHeaders).toEqual([]);
        else expect(authHeaders.length).toBeGreaterThan(0);
      }
    } finally {
      release();
    }
  });
}

test('delivered credentials do not make native-invalid block comments valid', async () => {
  await writeFile(
    join(root, 'models.json'),
    '/* unsupported comment */ {"providers":{"anthropic":{"apiKey":"host-key"}}}'
  );
  const native = await ModelRuntime.create({ refreshOnCreate: false });
  expect(native.getError()).toContain('Failed to parse models.json');

  await expect(
    createRequestModelRuntime(
      options => ModelRuntime.create({ ...options, refreshOnCreate: false }),
      undefined,
      {
        provider: 'anthropic',
        env: {},
        protectedEnvKeys: [],
        authoritativeCredential: true,
      }
    ).then(request => request.release())
  ).rejects.toThrow(SyntaxError);
});
