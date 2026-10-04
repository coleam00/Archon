import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { checkCredentialStatuses } from '@archon/provider-contract/conformance';
import { PiProvider, resolvePiAuth } from './provider';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelsError } from '@earendil-works/pi-ai';

const trackTempRoot = trackTempRoots();
const secret = 'planted-pi-credential';
const keys = [
  'PI_CODING_AGENT_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FEDERATION_RULE_ID',
] as const;
let previous: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  root = trackTempRoot(mkdtempSync(join(tmpdir(), 'pi-credential-check-')));
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, 'auth.json'), '{}');
  writeFileSync(
    join(root, 'models.json'),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: 'http://localhost:1234/v1',
          api: 'openai-completions',
          models: [{ id: 'model', name: 'Local' }],
        },
      },
    })
  );
});
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
const check = (model = 'anthropic/claude-sonnet-4-6', env: Record<string, string> = {}) =>
  new PiProvider().checkCredential({ model, env, signal: AbortSignal.timeout(2000) });

describe('Pi native credentials', () => {
  test('API keys resolve through the native runtime without surfacing the key', async () => {
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: secret } })
    );
    expect(
      await checkCredentialStatuses([{ name: 'Pi API key', expected: 'usable', secret, check }])
    ).toEqual([]);
  });
  test('uses the native Pi default model when Archon has none', async () => {
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' })
    );
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: secret } })
    );
    expect(
      await new PiProvider().checkCredential({ env: {}, signal: AbortSignal.timeout(2000) })
    ).toEqual({ state: 'usable', source: 'native' });
  });
  test('a request env key overrides a stored OAuth grant', async () => {
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'oauth', access: secret, refresh: 'dead-refresh', expires: 1 },
      })
    );
    expect(await check(undefined, { ANTHROPIC_API_KEY: secret })).toEqual({
      state: 'usable',
      source: 'native',
    });
  });
  test('uses assistant config model and key with request env taking precedence', async () => {
    const request = {
      assistantConfig: { model: 'anthropic/claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: secret } },
      env: {},
      signal: AbortSignal.timeout(2000),
    };
    expect(await new PiProvider().checkCredential(request)).toEqual({
      state: 'usable',
      source: 'native',
    });
    expect(
      await new PiProvider().checkCredential({ ...request, env: { ANTHROPIC_API_KEY: '' } })
    ).toEqual({ state: 'not_connected', source: 'native' });
  });
  test('an expired OAuth grant reports a failed native refresh', async () => {
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'oauth', access: secret, refresh: 'dead-refresh', expires: 1 },
      })
    );
    const runtime = await ModelRuntime.create();
    const oauth = runtime.getProvider('anthropic')?.auth.oauth;
    if (!oauth) throw new Error('Anthropic OAuth runtime missing');
    const refresh = spyOn(oauth, 'refresh').mockRejectedValue(
      new ModelsError('oauth', 'refresh fixture failed')
    );
    const create = spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
    try {
      expect(
        await checkCredentialStatuses([
          { name: 'Pi OAuth', expected: 'check_failed', secret, check },
        ])
      ).toEqual([]);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
      refresh.mockRestore();
    }
  });
  test('reads the per-run auth file a turn reads', async () => {
    const authPath = join(root, 'delivered-auth.json');
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: secret } }));
    expect(await check(undefined, { ARCHON_PI_AUTH_PATH: authPath })).toEqual({
      state: 'usable',
      source: 'native',
    });
  });
  test('substitutes a custom provider key from the request env the way a turn does', async () => {
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: 'http://localhost:1234/v1',
            api: 'openai-completions',
            apiKey: '${PI_CHECK_LOCAL_KEY}',
            models: [{ id: 'model', name: 'Local' }],
          },
        },
      })
    );
    expect(await check('local/model', { PI_CHECK_LOCAL_KEY: secret })).toEqual({
      state: 'usable',
      source: 'native',
    });
  });
  describe('a runtime error that echoes a configured credential', () => {
    const leakingRefresh = async () => {
      writeFileSync(
        join(root, 'auth.json'),
        JSON.stringify({
          anthropic: { type: 'oauth', access: 'stale', refresh: 'dead-refresh', expires: 1 },
        })
      );
      const runtime = await ModelRuntime.create();
      const oauth = runtime.getProvider('anthropic')?.auth.oauth;
      if (!oauth) throw new Error('Anthropic OAuth runtime missing');
      const refresh = spyOn(oauth, 'refresh').mockRejectedValue(
        new ModelsError('auth', `refresh rejected for ${secret}`)
      );
      const create = spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
      return (): void => {
        create.mockRestore();
        refresh.mockRestore();
      };
    };
    const fixtureEnv = { PI_FIXTURE_TOKEN: secret };

    test('is redacted from the check, with the value in the request env', async () => {
      const restore = await leakingRefresh();
      try {
        expect(await check(undefined, fixtureEnv)).toEqual({
          state: 'check_failed',
          source: 'native',
          evidence: 'OAuth refresh failed for anthropic: refresh rejected for [REDACTED]',
        });
      } finally {
        restore();
      }
    });
    test('is redacted from the check, with the value in assistant config env', async () => {
      const restore = await leakingRefresh();
      try {
        expect(
          await new PiProvider().checkCredential({
            assistantConfig: { model: 'anthropic/claude-sonnet-4-6', env: fixtureEnv },
            env: {},
            signal: AbortSignal.timeout(2000),
          })
        ).toEqual({
          state: 'check_failed',
          source: 'native',
          evidence: 'OAuth refresh failed for anthropic: refresh rejected for [REDACTED]',
        });
      } finally {
        restore();
      }
    });
    test('is redacted from the check when the runtime cannot be created', async () => {
      const create = spyOn(ModelRuntime, 'create').mockRejectedValue(
        new Error(`models config rejected ${secret}`)
      );
      try {
        expect(await check(undefined, fixtureEnv)).toEqual({
          state: 'check_failed',
          source: 'native',
          evidence: 'models config rejected [REDACTED]',
        });
      } finally {
        create.mockRestore();
      }
    });
    test('is redacted from the failed turn', async () => {
      const restore = await leakingRefresh();
      try {
        const chunks = [];
        for await (const chunk of new PiProvider().sendQuery('test', root, undefined, {
          model: 'anthropic/claude-sonnet-4-6',
          env: fixtureEnv,
        }))
          chunks.push(chunk);
        const result = JSON.stringify(chunks.find(chunk => chunk.type === 'result'));
        expect(result).toContain('refresh rejected for [REDACTED]');
        expect(result).not.toContain(secret);
      } finally {
        restore();
      }
    });
  });
  test('mapped missing auth is not_connected; a local provider is not_checked', async () => {
    expect(await check()).toEqual({ state: 'not_connected', source: 'native' });
    expect(await check('local/model')).toEqual({ state: 'not_checked', source: 'native' });
  });
  test('a model outside the static catalog is not_checked, as a turn defers it to extensions', async () => {
    expect(await check('anthropic/extension-model')).toEqual({
      state: 'not_checked',
      source: 'native',
    });
  });
  test('send reports auth only for the mapped missing credential', async () => {
    const chunks = [];
    for await (const chunk of new PiProvider().sendQuery('test', root, undefined, {
      model: 'anthropic/claude-sonnet-4-6',
    }))
      chunks.push(chunk);
    const result = chunks.find(chunk => chunk.type === 'result');
    expect(result).toMatchObject({ failure: { class: 'auth' } });
  });
  test('the native check executes a configured key command', async () => {
    const marker = join(root, 'command-ran');
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'api_key', key: `!printf ran > '${marker}'; printf '${secret}'` },
      })
    );
    expect(await check()).toEqual({ state: 'usable', source: 'native' });
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('ran');
  });
  test('a failing models.json key command fails the check and the turn alike', async () => {
    const marker = join(root, 'command-ran');
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({ providers: { anthropic: { apiKey: `!printf ran > '${marker}'; exit 1` } } })
    );
    expect(await check()).toMatchObject({ state: 'unusable', source: 'native' });
    expect(readFileSync(marker, 'utf8')).toBe('ran');
    const chunks = [];
    for await (const chunk of new PiProvider().sendQuery('test', root, undefined, {
      model: 'anthropic/claude-sonnet-4-6',
    }))
      chunks.push(chunk);
    expect(chunks.find(chunk => chunk.type === 'result')).toMatchObject({
      failure: { class: 'auth' },
    });
  });
  describe('a turn against a local server', () => {
    let server: ReturnType<typeof Bun.serve>;
    let authorizations: (string | null)[];
    let pin: ReturnType<typeof spyOn<ModelRuntime, 'setRuntimeApiKey'>>;
    beforeEach(() => {
      authorizations = [];
      server = Bun.serve({
        port: 0,
        fetch(request) {
          authorizations.push(request.headers.get('authorization'));
          return Response.json({ error: { message: 'fixture rejection' } }, { status: 401 });
        },
      });
      pin = spyOn(ModelRuntime.prototype, 'setRuntimeApiKey');
      // Each retry resolves the key again; one attempt keeps the counts about the node.
      writeFileSync(join(root, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
    });
    afterEach(async () => {
      pin.mockRestore();
      await server.stop(true);
    });
    const localProvider = (apiKey?: string): void => {
      writeFileSync(
        join(root, 'models.json'),
        JSON.stringify({
          providers: {
            local: {
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              api: 'openai-completions',
              ...(apiKey ? { apiKey } : {}),
              models: [{ id: 'model', name: 'Local' }],
            },
          },
        })
      );
    };
    const runTurn = async (): Promise<void> => {
      for await (const _chunk of new PiProvider().sendQuery('test', root, undefined, {
        model: 'local/model',
      }));
    };

    test('a node runs a models.json key command once, and doctor runs it once', async () => {
      const runs = join(root, 'runs');
      const runCount = (): number =>
        existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').length : 0;
      localProvider(`!printf 'run\\n' >> '${runs}'; printf '${secret}'`);

      expect(await check('local/model')).toEqual({ state: 'usable', source: 'native' });
      expect(runCount()).toBe(1);

      await runTurn();
      // The request carried the key the command printed, and the command ran once more.
      expect(authorizations.length).toBeGreaterThan(0);
      expect(new Set(authorizations)).toEqual(new Set([`Bearer ${secret}`]));
      expect(runCount()).toBe(2);
      expect(pin).toHaveBeenCalledTimes(1);
    });
    test('a stored auth.json key is not pinned, so Pi keeps resolving it', async () => {
      localProvider();
      writeFileSync(
        join(root, 'auth.json'),
        JSON.stringify({ local: { type: 'api_key', key: secret } })
      );
      await runTurn();
      expect(new Set(authorizations)).toEqual(new Set([`Bearer ${secret}`]));
      expect(pin).not.toHaveBeenCalled();
    });
  });
  test('a model only in the persisted catalog is checked as a turn checks it', async () => {
    // Pi's refresh restores the persisted pi.dev catalog, where models newer than the
    // bundled catalog live. A runtime built without it would defer this model to extensions.
    writeFileSync(
      join(root, 'models-store.json'),
      JSON.stringify({
        anthropic: {
          lastModified: Number.MAX_SAFE_INTEGER,
          models: [
            {
              id: 'claude-persisted-only',
              name: 'Persisted only',
              api: 'anthropic-messages',
              provider: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      })
    );
    expect(await check('anthropic/claude-persisted-only')).toEqual({
      state: 'not_connected',
      source: 'native',
    });
    const chunks = [];
    for await (const chunk of new PiProvider().sendQuery('test', root, undefined, {
      model: 'anthropic/claude-persisted-only',
    }))
      chunks.push(chunk);
    expect(chunks.find(chunk => chunk.type === 'result')).toMatchObject({
      failure: { class: 'auth' },
    });
  });
  test('typed auth rejection is unusable regardless of its prose', async () => {
    const runtime = await ModelRuntime.create();
    const auth = spyOn(runtime, 'checkAuth').mockRejectedValue(
      new ModelsError('auth', 'fixture rejection')
    );
    try {
      expect(await resolvePiAuth(runtime, 'anthropic', [])).toEqual({
        status: { state: 'unusable', source: 'native', evidence: 'fixture rejection' },
      });
    } finally {
      auth.mockRestore();
    }
  });
  test('a check cancelled while the key command runs is check_failed', async () => {
    const controller = new AbortController();
    const runtime: Parameters<typeof resolvePiAuth>[0] = {
      checkAuth: async () => ({ type: 'api_key', source: 'configured API key' }),
      getAuth: async () => {
        controller.abort(new Error('cancelled'));
        return { auth: { apiKey: secret }, source: 'configured API key' };
      },
    };
    expect(await resolvePiAuth(runtime, 'anthropic', [], controller.signal)).toEqual({
      status: { state: 'check_failed', source: 'native', evidence: 'cancelled' },
    });
  });
  test('aborted checks are check_failed', async () => {
    expect(
      await new PiProvider().checkCredential({
        model: 'anthropic/model',
        env: {},
        signal: AbortSignal.abort(new Error('cancelled')),
      })
    ).toEqual({ state: 'check_failed', source: 'native', evidence: 'cancelled' });
  });
});
