import { describe, it, expect, mock, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { removeTempTree } from '@archon/paths/test-utils';
import type { MergedConfig } from '@archon/core';
import { doctorLog } from './doctor-check';
import { checkAssistantLogin, type AssistantLoginDeps } from './doctor-assistant-login';

describe('checkAssistantLogin', () => {
  const config: MergedConfig = {
    botName: 'test',
    assistant: 'claude',
    assistants: { claude: {}, codex: {}, pi: { model: 'anthropic/claude-sonnet-4-6' } },
    streaming: { telegram: 'batch', discord: 'batch', slack: 'batch' },
    attentionNotices: [],
    concurrency: { maxConversations: 1 },
    workflows: { autoResumeOnQuotaReset: false },
    commands: { autoLoad: false },
    defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  };

  const deps = (
    state: import('@archon/provider-contract').CredentialStatus
  ): AssistantLoginDeps => ({
    assistant: 'pi',
    model: 'anthropic/claude-sonnet-4-6',
    vendor: 'anthropic',
    connectedVendors: [],
    provider: { checkCredential: mock(async () => state) },
  });

  for (const [state, expected] of [
    ['usable', 'pass'],
    ['not_checked', 'skip'],
    ['check_failed', 'warn'],
    ['unusable', 'fail'],
    ['not_connected', 'fail'],
  ] as const) {
    it(`maps ${state} to ${expected}`, async () => {
      const fixture = deps(
        state === 'unusable' || state === 'check_failed'
          ? { state, source: 'native', evidence: 'runtime evidence' }
          : { state, source: 'native' }
      );
      const result = await checkAssistantLogin(
        { DEFAULT_AI_ASSISTANT: 'claude', TEST_KEY: 'secret' },
        async () => fixture
      );
      expect(result.status).toBe(expected);
      expect(result.message).toContain('pi:');
      expect(fixture.provider.checkCredential).toHaveBeenCalledWith({
        assistantConfig: fixture.assistantConfig,
        model: fixture.model,
        env: { DEFAULT_AI_ASSISTANT: 'claude', TEST_KEY: 'secret' },
        signal: expect.any(AbortSignal),
      });
      if (state === 'check_failed' || state === 'unusable')
        expect(result.message).toContain('runtime evidence');
      if (state === 'not_checked') expect(result.message).toContain('not checked');
    });
  }

  it('checks only the configured Claude assistant', async () => {
    const { ClaudeProvider } = await import('@archon/providers/in-process');
    const check = spyOn(ClaudeProvider.prototype, 'checkCredential').mockResolvedValue({
      state: 'usable',
      source: 'native',
    });
    try {
      const result = await checkAssistantLogin({ DEFAULT_AI_ASSISTANT: 'pi' }, async () => ({
        assistant: 'claude',
        connectedVendors: [],
        provider: new ClaudeProvider(),
      }));
      expect(result).toMatchObject({ status: 'pass', message: 'claude: usable' });
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      check.mockRestore();
    }
  });

  it('loads the merged default assistant without consulting the Pi login', async () => {
    const core = await import('@archon/core');
    const { ClaudeProvider, PiProvider, registerBuiltinProviders, registerCommunityProviders } =
      await import('@archon/providers/in-process');
    registerBuiltinProviders();
    registerCommunityProviders();
    const load = spyOn(core, 'loadConfig').mockResolvedValue(config);
    const pi = spyOn(PiProvider.prototype, 'checkCredential');
    const claude = spyOn(ClaudeProvider.prototype, 'checkCredential').mockResolvedValue({
      state: 'usable',
      source: 'native',
    });
    try {
      expect(await checkAssistantLogin({ DEFAULT_AI_ASSISTANT: 'pi' })).toMatchObject({
        status: 'pass',
        message: 'claude: usable',
      });
      expect(load).toHaveBeenCalledWith(process.cwd());
      expect(pi).not.toHaveBeenCalled();
      expect(claude).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
      pi.mockRestore();
      claude.mockRestore();
    }
  });

  it('checks a Pi key supplied only by merged assistant config', async () => {
    const core = await import('@archon/core');
    const { registerBuiltinProviders, registerCommunityProviders } = await import(
      '@archon/providers/in-process'
    );
    registerBuiltinProviders();
    registerCommunityProviders();
    const root = mkdtempSync(join(tmpdir(), 'doctor-pi-config-'));
    const keys = [
      'PI_CODING_AGENT_DIR',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = root;
    writeFileSync(join(root, 'auth.json'), '{}');
    const load = spyOn(core, 'loadConfig').mockResolvedValue({
      ...config,
      assistant: 'pi',
      assistants: {
        ...config.assistants,
        pi: {
          model: 'anthropic/claude-sonnet-4-6',
          env: { ANTHROPIC_API_KEY: 'config-only-key' },
        },
      },
    });
    try {
      expect(await checkAssistantLogin({})).toMatchObject({
        status: 'pass',
        message: 'pi: usable',
      });
    } finally {
      load.mockRestore();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await removeTempTree(root);
    }
  });

  it("skips native login only for the configured model's connected vendor", async () => {
    const core = await import('@archon/core');
    const userDb = await import('@archon/core/db/users');
    const { PiProvider, registerBuiltinProviders, registerCommunityProviders } = await import(
      '@archon/providers/in-process'
    );
    registerBuiltinProviders();
    registerCommunityProviders();
    const load = spyOn(core, 'loadConfig').mockResolvedValue({ ...config, assistant: 'pi' });
    const user = spyOn(userDb, 'findOrCreateUserByPlatformIdentity').mockResolvedValue({
      id: 'cli-user',
      display_name: null,
      email: null,
      role: 'member',
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const rows = spyOn(core, 'listUserProviderKeys');
    const native = spyOn(PiProvider.prototype, 'checkCredential').mockResolvedValue({
      state: 'not_connected',
      source: 'native',
    });
    try {
      rows.mockResolvedValue([{ provider: 'openai', kind: 'api_key', label: null }]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'fail',
      });
      expect(native).toHaveBeenCalledTimes(1);
      rows.mockResolvedValue([{ provider: 'anthropic', kind: 'api_key', label: null }]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'pass',
        message: 'pi: uses the credential connected in Archon',
      });
      expect(native).toHaveBeenCalledTimes(1);
      // A pre-#1955 agent-keyed row is delivered as its vendor, so it counts as one.
      rows.mockResolvedValue([{ provider: 'claude', kind: 'api_key', label: null }]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'pass',
        message: 'pi: uses the credential connected in Archon',
      });
      expect(native).toHaveBeenCalledTimes(1);
      // Pi cannot use a connected Claude subscription, so doctor checks the native login
      // and, finding none, points at the provider that can.
      rows.mockResolvedValue([{ provider: 'anthropic', kind: 'oauth', label: null }]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toEqual({
        label: 'Assistant login',
        status: 'fail',
        message:
          'pi: no native credential, and the anthropic subscription connected in Archon runs on `provider: claude`, not on pi. Use `provider: claude`, or give pi its own anthropic API key.',
      });
      expect(native).toHaveBeenCalledTimes(2);
      // With no model in Archon config, doctor cannot tell which connected vendor the run
      // uses, so a missing native login is a warning that names the connected one.
      load.mockResolvedValue({
        ...config,
        assistant: 'pi',
        assistants: { ...config.assistants, pi: {} },
      });
      rows.mockResolvedValue([{ provider: 'anthropic', kind: 'api_key', label: null }]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('anthropic'),
      });
      expect(native).toHaveBeenCalledTimes(3);
      // A credential Pi cannot use does not soften a missing native login.
      rows.mockResolvedValue([{ provider: 'not-a-pi-vendor', kind: 'api_key', label: null }]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'fail',
      });
      rows.mockResolvedValue([]);
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'fail',
      });
      // A failed credential lookup still runs the native check, as if nothing were connected.
      const callsBefore = native.mock.calls.length;
      rows.mockRejectedValue(new Error('database unreachable'));
      expect(await checkAssistantLogin({ ARCHON_USER_ID: 'operator' })).toMatchObject({
        status: 'fail',
        message:
          'pi: no native credential. Log in through pi or connect a credential with `archon ai`.',
      });
      expect(native.mock.calls.length).toBe(callsBefore + 1);
    } finally {
      native.mockRestore();
      rows.mockRestore();
      user.mockRestore();
      load.mockRestore();
    }
  });

  it('logs the error when the connected-credential lookup fails', async () => {
    const core = await import('@archon/core');
    const userDb = await import('@archon/core/db/users');
    const { PiProvider, registerBuiltinProviders, registerCommunityProviders } = await import(
      '@archon/providers/in-process'
    );
    registerBuiltinProviders();
    registerCommunityProviders();
    const lookupError = new Error('database unreachable');
    const load = spyOn(core, 'loadConfig').mockResolvedValue({ ...config, assistant: 'pi' });
    const user = spyOn(userDb, 'findOrCreateUserByPlatformIdentity').mockRejectedValue(lookupError);
    const native = spyOn(PiProvider.prototype, 'checkCredential').mockResolvedValue({
      state: 'not_connected',
      source: 'native',
    });
    const debug = spyOn(doctorLog(), 'debug');
    try {
      await checkAssistantLogin({ ARCHON_USER_ID: 'operator' });
      expect(debug).toHaveBeenCalledWith(
        { err: lookupError },
        'doctor.assistant_login_credential_lookup_failed'
      );
    } finally {
      debug.mockRestore();
      native.mockRestore();
      user.mockRestore();
      load.mockRestore();
    }
  });

  it('uses the connected credential without checking native login', async () => {
    const fixture = {
      ...deps({ state: 'unusable', source: 'native', evidence: 'dead native login' }),
      connectedVendors: ['anthropic'],
    };
    const result = await checkAssistantLogin({}, async () => fixture);
    expect(result).toMatchObject({
      status: 'pass',
      message: 'pi: uses the credential connected in Archon',
    });
    expect(fixture.provider.checkCredential).not.toHaveBeenCalled();
  });

  it('warns on a dead native login when an unconfigured model may use a connected credential', async () => {
    const fixture = {
      ...deps({ state: 'unusable', source: 'native', evidence: 'dead native login' }),
      model: undefined,
      vendor: undefined,
      connectedVendors: ['anthropic', 'openai'],
    };
    expect(await checkAssistantLogin({}, async () => fixture)).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('dead native login'),
    });
    expect((await checkAssistantLogin({}, async () => fixture)).message).toContain(
      'anthropic, openai'
    );
  });

  it('fails a dead native login for a configured model with no credential vendor', async () => {
    // A Pi models.json provider: the model is set, so no connected credential can stand in.
    const fixture = {
      ...deps({ state: 'unusable', source: 'native', evidence: 'dead native login' }),
      model: 'my-gateway/model',
      vendor: undefined,
      connectedVendors: ['anthropic'],
    };
    expect(await checkAssistantLogin({}, async () => fixture)).toMatchObject({
      status: 'fail',
      message: expect.not.stringContaining('set a model'),
    });
  });

  it('warns if the configured login could not be checked', async () => {
    expect(
      await checkAssistantLogin({}, async () => {
        throw new Error('config unavailable');
      })
    ).toMatchObject({ status: 'warn', message: expect.stringContaining('config unavailable') });
  });
});
