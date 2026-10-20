import {
  mockLogger,
  mockCreateAgentSession,
  fileCreds,
  runtimeOverrides,
  mockSetRuntimeApiKey,
  mockGetAuth,
  mockModelRegistryConstruct,
  mockModelRuntimeCreate,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { PiProvider } from './provider';
describe('PiProvider auth', () => {
  test('logs credential hint when Pi provider id is unknown AND no creds available', async () => {
    // No env var, no auth.json entry → log hint, but continue, to support custom providers that don't use credentials or that use non-Pi means of providing credentials.
    resetScript(scriptedAgentEnd());
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'unknownprovider/some-model',
      })
    );

    expect(error).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        piProvider: 'unknownprovider',
      },
      'pi.auth_missing'
    );
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
  });

  test('new ModelRegistry receives the ModelRuntime instance', async () => {
    // pi 0.84.0+: ModelRegistry is now a class constructed from a ModelRuntime
    // (the pre-0.84 `ModelRegistry.create(authStorage)` factory is gone). The
    // runtime the registry wraps is the same one we built with `setRuntimeApiKey`
    // calls and the same one createAgentSession uses to resolve auth on send.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(mockModelRuntimeCreate).toHaveBeenCalledTimes(1);
    expect(mockModelRegistryConstruct).toHaveBeenCalledTimes(1);
    // The runtime passed to the registry constructor is the resolved value
    // of the Promise returned by ModelRuntime.create (the wrapper awaits it
    // before constructing the registry, per the new SDK contract).
    const runtimeInstance = await mockModelRuntimeCreate.mock.results[0]?.value;
    expect(mockModelRegistryConstruct).toHaveBeenCalledWith(runtimeInstance);
  });

  test('ModelRuntime.create reads ARCHON_PI_AUTH_PATH from requestOptions.env (per-user channel)', async () => {
    // The executor delivers per-user credentials — including the per-run
    // auth.json PATH — on the per-call requestOptions.env channel, which it
    // deliberately keeps OUT of process.env (subprocess-isolation). Pi runs
    // in-process, so it must read the path from requestOptions.env or per-user
    // subscription delivery silently no-ops (the auth.json is written but never
    // loaded). Regression for the VPS smoke finding where a claude→anthropic
    // subscription failed with "no credentials for provider 'anthropic'".
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());
    const perRunAuthPath = '/run/abc123/pi-home/auth.json';

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: { ARCHON_PI_AUTH_PATH: perRunAuthPath },
      })
    );

    expect(mockModelRuntimeCreate).toHaveBeenCalledWith({ authPath: perRunAuthPath });
  });

  test('a delivered auth file outranks competing host and request API keys', async () => {
    fileCreds.anthropic = { type: 'oauth' };
    process.env.ANTHROPIC_API_KEY = 'host-key';
    resetScript(scriptedAgentEnd());
    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: { ARCHON_PI_AUTH_PATH: '/run/user/auth.json', ANTHROPIC_API_KEY: 'project-key' },
        protectedEnvKeys: ['ARCHON_PI_AUTH_PATH'],
        userCredentialEnvKeys: ['ARCHON_PI_AUTH_PATH'],
      })
    );
    expect(mockModelRuntimeCreate).toHaveBeenCalledWith({ authPath: '/run/user/auth.json' });
    expect(mockSetRuntimeApiKey).not.toHaveBeenCalled();
  });

  for (const protectedKey of ['ARCHON_PI_AUTH_PATH', 'ANTHROPIC_API_KEY']) {
    test(`protected native ${protectedKey} keeps native configuration precedence`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-native-protected-'));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      try {
        writeFileSync(
          join(dir, 'models.json'),
          JSON.stringify({
            providers: {
              anthropic: { headers: { Authorization: 'Bearer native-config' } },
            },
          })
        );
        fileCreds.anthropic = { type: 'oauth' };
        resetScript(scriptedAgentEnd());
        await consume(
          new PiProvider().sendQuery('hi', '/tmp', undefined, {
            model: 'anthropic/claude-haiku-4-5',
            env: { ARCHON_PI_AUTH_PATH: '/run/native/auth.json', ANTHROPIC_API_KEY: 'native-key' },
            protectedEnvKeys: [protectedKey],
          })
        );
        expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'native-key');
        expect(mockModelRuntimeCreate).toHaveBeenCalledWith({ authPath: '/run/native/auth.json' });
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeTempTree(dir);
      }
    });
  }

  test('ModelRuntime.create falls back to process.env.ARCHON_PI_AUTH_PATH (shell override)', async () => {
    // A shell-level ARCHON_PI_AUTH_PATH still applies when no per-call value is
    // present, preserving the local-dev / manual override path.
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());
    process.env.ARCHON_PI_AUTH_PATH = '/shell/override/auth.json';

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );

    expect(mockModelRuntimeCreate).toHaveBeenCalledWith({ authPath: '/shell/override/auth.json' });
  });

  test('ModelRuntime.create() throwing surfaces a contextualized error', async () => {
    // ModelRuntime.create() reads the auth.json from disk and can throw on
    // malformed JSON or filesystem errors. Wrap with try/catch and surface a
    // Pi-framed error so operators see the cause rather than a raw SDK stack
    // trace.
    mockModelRuntimeCreate.mockImplementationOnce(async () => {
      throw new Error('Unexpected token } in JSON at position 42');
    });

    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(failure?.class).toBe('unknown');
    expect(failure?.evidence).toContain('Pi auth storage init failed');
    expect(failure?.evidence).toContain('Unexpected token');
    expect(failure?.evidence).toContain('~/.pi/agent/auth.json');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ piProvider: 'google' }),
      'pi.auth_storage_init_failed'
    );
  });

  test('reports a failure when env var missing AND auth.json has no entry', async () => {
    // GEMINI_API_KEY not set (beforeEach deletes it), fileCreds empty
    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(failure?.class).toBe('auth');
    expect(failure?.evidence).toContain('no credentials for provider');
    expect(failure?.evidence).toContain('GEMINI_API_KEY');
    expect(failure?.evidence).toContain('/login');
  });

  test('uses OAuth credential from ~/.pi/agent/auth.json when no env var set', async () => {
    // Simulate user running `pi /login` → auth.json has OAuth entry
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(error).toBeUndefined();
    // Runtime override NOT set — no env var present — so Pi's getAuth
    // resolves through the OAuth code path.
    expect(mockSetRuntimeApiKey).not.toHaveBeenCalled();
    expect(mockGetAuth).toHaveBeenCalledWith('anthropic', { signal: undefined });
  });

  test('a configured login that resolves to nothing names no env var the provider lacks', async () => {
    fileCreds['local-oauth'] = { type: 'oauth' };
    mockGetAuth.mockImplementationOnce(async () => undefined);
    resetScript(scriptedAgentEnd());

    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'local-oauth/model' })
    );

    expect(failure?.class).toBe('auth');
    expect(failure?.evidence).toContain("no credentials for provider 'local-oauth'");
    expect(failure?.evidence).not.toContain('undefined');
  });

  test('a Pi turn on an Anthropic model with only an Archon-delivered subscription fails before the session starts and names provider: claude', async () => {
    resetScript(scriptedAgentEnd());

    // The env bag chat delivery built from a stored Claude subscription.
    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-delivered',
          ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-delivered',
        },
      })
    );

    expect(failure?.class).toBe('auth');
    expect(failure?.evidence).toContain('provider: claude');
    expect(failure?.evidence).toContain('ANTHROPIC_API_KEY');
    expect(failure?.evidence).not.toContain('sk-ant-oat01-delivered');
    expect(mockSetRuntimeApiKey).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  test('request env (codebase env vars) overrides process.env via setRuntimeApiKey', async () => {
    process.env.GEMINI_API_KEY = 'from-process-env';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { GEMINI_API_KEY: 'from-request-env' },
      })
    );

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'from-request-env');
    // Runtime override is priority #1 in Pi's resolution chain, so getApiKey
    // returns 'from-request-env' (via our mock's runtimeOverrides map).
    expect(runtimeOverrides.google).toBe('from-request-env');
  });

  test('env var overrides auth.json api_key entry', async () => {
    // Both present: env var wins (mirrors Pi's resolution priority)
    fileCreds.anthropic = { type: 'api_key', key: 'from-auth-json' };
    process.env.ANTHROPIC_API_KEY = 'from-env';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'from-env');
  });
});
