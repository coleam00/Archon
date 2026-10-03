/**
 * Tests for `archon doctor` check functions.
 *
 * Uses spyOn for `@archon/git.execFileAsync` and `globalThis.fetch`.
 * `BUNDLED_IS_BINARY` is a static const re-export and cannot be spied at
 * runtime — `checkClaudeBinary` accepts it as an injectable parameter for
 * testability. Avoids `mock.module()` because it is process-global and
 * irreversible in Bun, which would pollute other test files in this package.
 */
import { describe, it, expect, mock, spyOn, afterEach, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as git from '@archon/git';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { copyArchonSkill } from './skill';
import {
  checkClaudeBinary,
  checkCodexBinary,
  checkConfigFiles,
  checkOpenCode,
  checkDatabase,
  checkConnectedProviders,
  checkGhAuth,
  checkAssistantLogin,
  type AssistantLoginDeps,
  checkWorkspaceWritable,
  checkBundledDefaults,
  checkSlack,
  checkTelegram,
  checkTelemetry,
  checkFolderProject,
  checkArchonSkill,
  defaultLoadClaudeBinaryDeps,
  doctorCommand,
  type ClaudeBinaryDeps,
  type CodexBinaryDeps,
  type DatabaseDeps,
  type FolderProjectDeps,
  type OpenCodeDeps,
  type ProviderDeps,
} from './doctor';
import type { MergedConfig } from '@archon/core';

describe('checkClaudeBinary', () => {
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  const noDeps = async (): Promise<ClaudeBinaryDeps> => ({});

  it('returns skip when not in binary mode', async () => {
    const result = await checkClaudeBinary(false);
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Claude binary');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns fail in binary mode when the whole resolution chain is empty', async () => {
    const result = await checkClaudeBinary(true, noDeps, async () => {
      throw new Error('Claude Code not found. Archon requires the Claude Code executable');
    });
    expect(result.status).toBe('fail');
    // The resolver's install instructions are surfaced verbatim — they are the
    // actionable message, unlike the old "CLAUDE_BIN_PATH is not set".
    expect(result.message).toContain('Claude Code not found');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns pass in binary mode when binary spawns successfully', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    const result = await checkClaudeBinary(true, noDeps, async () => ({
      path: '/opt/claude',
      source: 'env',
    }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('/opt/claude');
    expect(execSpy).toHaveBeenCalledWith('/opt/claude', ['--version'], expect.any(Object));
  });

  it('returns fail in binary mode when spawn throws', async () => {
    execSpy.mockRejectedValue(new Error('ENOENT'));
    const result = await checkClaudeBinary(true, noDeps, async () => ({
      path: '/opt/claude',
      source: 'env',
    }));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('did not spawn');
    expect(result.message).toContain('ENOENT');
  });

  // #2263: doctor previously read only CLAUDE_BIN_PATH and hard-FAILed setups
  // configured via assistants.claude.claudeBinaryPath — the documented fix for
  // compiled builds — even though those setups run workflows fine.
  it('passes when the binary comes from config rather than CLAUDE_BIN_PATH (#2263)', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    let sawConfigPath: string | undefined;
    const result = await checkClaudeBinary(
      true,
      async () => ({ configBinaryPath: '/Users/me/bin/claude' }),
      async configPath => {
        sawConfigPath = configPath;
        return { path: configPath as string, source: 'config' };
      }
    );

    // The config path must actually reach the resolver, not be ignored.
    expect(sawConfigPath).toBe('/Users/me/bin/claude');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('/Users/me/bin/claude');
    // Which tier resolved it is surfaced so users can see what the runtime does.
    expect(result.message).toContain('via config');
    expect(result.message).not.toContain('CLAUDE_BIN_PATH is not set');
  });

  it('reports the autodetect tier when the native installer path resolves', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    const result = await checkClaudeBinary(true, noDeps, async () => ({
      path: '/home/me/.local/bin/claude',
      source: 'autodetect',
    }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('via autodetect');
  });

  it('degrades to env/autodetect when config loading throws', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    const result = await checkClaudeBinary(
      true,
      async () => {
        throw new Error('malformed config.yaml');
      },
      async configPath => {
        expect(configPath).toBeUndefined();
        return { path: '/opt/claude', source: 'env' };
      }
    );
    // A broken config must not fail the binary check outright.
    expect(result.status).toBe('pass');
  });

  // The tests above inject BOTH seams, so they only prove parameter plumbing
  // inside checkClaudeBinary. The two below exercise the real
  // defaultLoadClaudeBinaryDeps, which is where #2263 actually lived: reading
  // the wrong config key type-checks and would otherwise ship green.
  // The stub config deliberately carries a DIFFERENT value under
  // assistants.codex.codexBinaryPath so a key mix-up fails loudly rather than
  // resolving to the same string by accident.
  const stubConfig = async (): Promise<Pick<MergedConfig, 'assistants'>> => ({
    assistants: {
      claude: { claudeBinaryPath: '/from/claude/config' },
      codex: { codexBinaryPath: '/from/codex/config' },
    },
  });

  it('reads assistants.claude.claudeBinaryPath, not another assistant key (#2263)', async () => {
    const deps = await defaultLoadClaudeBinaryDeps(stubConfig);
    expect(deps.configBinaryPath).toBe('/from/claude/config');
  });

  it('routes the real deps loader through to the resolver (#2263 wiring guard)', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    let sawConfigPath: string | undefined;

    const result = await checkClaudeBinary(
      true,
      // The real loader, not a fake — this is the link the bug broke.
      () => defaultLoadClaudeBinaryDeps(stubConfig),
      async configPath => {
        sawConfigPath = configPath;
        return { path: configPath as string, source: 'config' };
      }
    );

    expect(sawConfigPath).toBe('/from/claude/config');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('via config');
  });
});

describe('checkCodexBinary', () => {
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  const notConfigured: CodexBinaryDeps = {
    isDefaultAssistant: false,
    credentialConnected: false,
  };
  const loadDeps = (deps: CodexBinaryDeps) => async () => deps;
  const resolvesTo =
    (path: string, source: 'env' | 'config' | 'vendor' | 'autodetect') => async () => ({
      path,
      source,
    });

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('skips when Codex is not configured and no credential is connected', async () => {
    const result = await checkCodexBinary({}, loadDeps(notConfigured), async () => undefined);
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Codex binary');
    expect(result.message).toContain('not configured');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('runs (dev-mode skip) when DEFAULT_AI_ASSISTANT=codex even if config load fails', async () => {
    // loadDeps throwing must not suppress the check — env signal still counts.
    const result = await checkCodexBinary(
      { DEFAULT_AI_ASSISTANT: 'codex' },
      async () => {
        throw new Error('config blew up');
      },
      async () => undefined // resolver returns undefined → dev mode
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('dev mode');
  });

  it('runs when a config codexBinaryPath is set (configured signal)', async () => {
    const result = await checkCodexBinary(
      {},
      loadDeps({ ...notConfigured, configBinaryPath: '/cfg/codex' }),
      async () => undefined
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('dev mode');
  });

  it('runs when an OpenAI (Codex) credential is connected', async () => {
    const result = await checkCodexBinary(
      {},
      loadDeps({ ...notConfigured, credentialConnected: true }),
      async () => undefined
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('dev mode');
  });

  it('passes and reports the resolved source when the binary spawns', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    const result = await checkCodexBinary(
      { DEFAULT_AI_ASSISTANT: 'codex' },
      loadDeps(notConfigured),
      resolvesTo('/opt/codex', 'autodetect')
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('/opt/codex');
    expect(result.message).toContain('via autodetect');
    expect(execSpy).toHaveBeenCalledWith('/opt/codex', ['--version'], expect.any(Object));
  });

  it('fails with install instructions when the resolver throws', async () => {
    const result = await checkCodexBinary(
      { DEFAULT_AI_ASSISTANT: 'codex' },
      loadDeps(notConfigured),
      async () => {
        throw new Error(
          'Codex CLI binary not found. Install globally: npm install -g @openai/codex'
        );
      }
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Codex CLI binary not found');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('surfaces a stale-pin candidate hint verbatim', async () => {
    const diagnostic =
      'assistants.codex.codexBinaryPath is set to "/stale/codex" but the file does not exist.\n\n' +
      'A Codex binary was found at /opt/codex.\n' +
      'Update assistants.codex.codexBinaryPath to that path, or remove codexBinaryPath to let Archon detect it.';
    const result = await checkCodexBinary(
      { DEFAULT_AI_ASSISTANT: 'codex' },
      loadDeps(notConfigured),
      async () => {
        throw new Error(diagnostic);
      }
    );

    expect(result).toEqual({ label: 'Codex binary', status: 'fail', message: diagnostic });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('fails when the resolved binary does not spawn', async () => {
    execSpy.mockRejectedValue(new Error('ENOENT'));
    const result = await checkCodexBinary(
      { CODEX_BIN_PATH: '/opt/codex' },
      loadDeps(notConfigured),
      resolvesTo('/opt/codex', 'env')
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('did not spawn');
    expect(result.message).toContain('ENOENT');
  });
});

describe('checkOpenCode', () => {
  const makeDeps = (over: Partial<OpenCodeDeps> = {}): OpenCodeDeps => ({
    isDefaultAssistant: false,
    probeRuntimeModule: async () => true,
    ...over,
  });

  it('skips when OpenCode is not configured and --full is absent', async () => {
    const result = await checkOpenCode({}, false, async () => makeDeps());
    expect(result.status).toBe('skip');
    expect(result.label).toBe('OpenCode runtime');
    expect(result.message).toContain('pass --full');
  });

  it('passes when OpenCode is the configured assistant and the SDK resolves', async () => {
    const result = await checkOpenCode({}, false, async () =>
      makeDeps({ isDefaultAssistant: true })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('server not started');
  });

  it('passes under --full even when OpenCode is not configured', async () => {
    const result = await checkOpenCode({}, true, async () => makeDeps());
    expect(result.status).toBe('pass');
  });

  it('runs when DEFAULT_AI_ASSISTANT=opencode', async () => {
    const result = await checkOpenCode({ DEFAULT_AI_ASSISTANT: 'opencode' }, false, async () =>
      makeDeps()
    );
    expect(result.status).toBe('pass');
  });

  it('never boots the runtime — only the cheap module probe is called', async () => {
    let probeCalls = 0;
    await checkOpenCode({}, true, async () =>
      makeDeps({
        probeRuntimeModule: async () => {
          probeCalls += 1;
          return true;
        },
      })
    );
    expect(probeCalls).toBe(1);
  });

  it('fails when the runtime SDK cannot be resolved', async () => {
    const result = await checkOpenCode({}, true, async () =>
      makeDeps({
        probeRuntimeModule: async () => {
          throw new Error('Cannot find module @opencode-ai/sdk');
        },
      })
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not resolvable');
    expect(result.message).toContain('bun install');
  });

  it('fails when the SDK resolves but the entrypoint is missing', async () => {
    const result = await checkOpenCode({}, true, async () =>
      makeDeps({ probeRuntimeModule: async () => false })
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('createOpencode');
  });

  it('skips gracefully when deps load fails and --full is absent', async () => {
    const result = await checkOpenCode({}, false, async () => {
      throw new Error('config load failed');
    });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('not configured');
  });

  it('surfaces the load error (not "entrypoint missing") when deps fail under --full', async () => {
    const result = await checkOpenCode({}, true, async () => {
      throw new Error('config load failed');
    });
    expect(result.status).toBe('fail');
    // Must report the real load failure, not a fabricated SDK-entrypoint verdict.
    expect(result.message).toContain('config load failed');
    expect(result.message).not.toContain('createOpencode');
  });

  it('surfaces the load error when deps fail and OpenCode is the configured assistant', async () => {
    const result = await checkOpenCode({ DEFAULT_AI_ASSISTANT: 'opencode' }, false, async () => {
      throw new Error('module import failed');
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('module import failed');
    expect(result.message).not.toContain('createOpencode');
  });
});

describe('checkGhAuth', () => {
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('returns skip when no GitHub token is set', async () => {
    const result = await checkGhAuth({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('GitHub not configured');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('runs gh auth check when only GH_TOKEN is set', async () => {
    execSpy.mockResolvedValue({ stdout: 'Logged in as @user', stderr: '' });
    const result = await checkGhAuth({ GH_TOKEN: 'ghp_y' });
    expect(result.status).toBe('pass');
    expect(execSpy).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.any(Object));
  });

  it('returns pass when gh auth status succeeds', async () => {
    execSpy.mockResolvedValue({ stdout: 'Logged in as @user', stderr: '' });
    const result = await checkGhAuth({ GITHUB_TOKEN: 'ghp_x' });
    expect(result.status).toBe('pass');
    expect(execSpy).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.any(Object));
  });

  it('returns fail when gh auth status throws', async () => {
    execSpy.mockRejectedValue(new Error('not logged in'));
    const result = await checkGhAuth({ GH_TOKEN: 'ghp_y' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not logged in');
  });
});

describe('checkAssistantLogin', () => {
  const config: MergedConfig = {
    botName: 'test',
    assistant: 'claude',
    assistants: { claude: {}, codex: {}, pi: { model: 'anthropic/claude-sonnet-4-6' } },
    streaming: { telegram: 'batch', discord: 'batch', slack: 'batch' },
    paths: { workspaces: '/unused', worktrees: '/unused' },
    concurrency: { maxConversations: 1 },
    workflows: { autoResumeOnQuotaReset: false, quotaMaxAttempts: 1, quotaDeadlineMs: 1 },
    commands: { autoLoad: false },
    defaults: { copyDefaults: false, loadDefaultCommands: false, loadDefaultWorkflows: false },
  };

  const deps = (
    state: import('@archon/provider-contract').CredentialStatus
  ): AssistantLoginDeps => ({
    assistant: 'pi',
    model: 'anthropic/claude-sonnet-4-6',
    credentialConnected: false,
    provider: { checkCredential: mock(async () => state) },
  });

  for (const [state, expected] of [
    ['usable', 'pass'],
    ['not_checked', 'pass'],
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
        model: fixture.model,
        env: { DEFAULT_AI_ASSISTANT: 'claude', TEST_KEY: 'secret' },
        signal: expect.any(AbortSignal),
      });
      if (state === 'check_failed' || state === 'unusable')
        expect(result.message).toContain('runtime evidence');
      if (state === 'not_checked') expect(result.message).toContain('not checked');
    });
  }

  it('checks only the configured Claude assistant and reports not checked', async () => {
    const { ClaudeProvider } = await import('@archon/providers');
    const check = spyOn(ClaudeProvider.prototype, 'checkCredential');
    try {
      const result = await checkAssistantLogin({ DEFAULT_AI_ASSISTANT: 'pi' }, async () => ({
        assistant: 'claude',
        credentialConnected: false,
        provider: new ClaudeProvider(),
      }));
      expect(result).toMatchObject({ status: 'pass', message: 'claude: not checked' });
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      check.mockRestore();
    }
  });

  it('loads the merged default assistant without consulting the Pi login', async () => {
    const core = await import('@archon/core');
    const { PiProvider, registerBuiltinProviders, registerCommunityProviders } =
      await import('@archon/providers');
    registerBuiltinProviders();
    registerCommunityProviders();
    const load = spyOn(core, 'loadConfig').mockResolvedValue(config);
    const pi = spyOn(PiProvider.prototype, 'checkCredential');
    try {
      expect(await checkAssistantLogin({ DEFAULT_AI_ASSISTANT: 'pi' })).toMatchObject({
        status: 'pass',
        message: 'claude: not checked',
      });
      expect(load).toHaveBeenCalledWith(process.cwd());
      expect(pi).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      pi.mockRestore();
    }
  });

  it("skips native login only for the configured model's connected vendor", async () => {
    const core = await import('@archon/core');
    const userDb = await import('@archon/core/db/users');
    const { PiProvider, registerBuiltinProviders, registerCommunityProviders } =
      await import('@archon/providers');
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
    } finally {
      native.mockRestore();
      rows.mockRestore();
      user.mockRestore();
      load.mockRestore();
    }
  });

  it('uses the connected credential without checking native login', async () => {
    const fixture = {
      ...deps({ state: 'unusable', source: 'native', evidence: 'dead native login' }),
      credentialConnected: true,
    };
    const result = await checkAssistantLogin({}, async () => fixture);
    expect(result).toMatchObject({
      status: 'pass',
      message: 'pi: uses the credential connected in Archon',
    });
    expect(fixture.provider.checkCredential).not.toHaveBeenCalled();
  });

  it('warns if the configured login could not be checked', async () => {
    expect(
      await checkAssistantLogin({}, async () => {
        throw new Error('config unavailable');
      })
    ).toMatchObject({ status: 'warn', message: expect.stringContaining('config unavailable') });
  });
});

describe('checkConfigFiles', () => {
  it('passes and names the resolved default assistant', async () => {
    const result = await checkConfigFiles('/repo', async () => ({ assistant: 'codex' }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('codex');
  });

  it('fails with the loader message when assistants config is invalid', async () => {
    const result = await checkConfigFiles('/repo', async () => {
      throw new Error(
        "Invalid assistants config in '/repo/.archon/config.yaml': " +
          "'assistants.codex.modelReasoningEffort': expected minimal, low, medium, high, xhigh, max."
      );
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('assistants.codex.modelReasoningEffort');
  });
});

describe('checkDatabase', () => {
  const schemaVersion = {
    createdAppVersion: '0.5.3',
    appVersion: '0.6.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    appliedAt: '2026-07-01T00:00:00.000Z',
  };

  // Mirrors the makeDeps() helper in the checkFolderProject block below, so each
  // test states only the field it varies.
  function makeDeps(over: Partial<DatabaseDeps> = {}): DatabaseDeps {
    return {
      pool: { query: async () => undefined },
      getDatabaseType: () => 'sqlite',
      getSchemaVersion: async () => schemaVersion,
      ...over,
    };
  }

  it('returns pass when query succeeds', async () => {
    const result = await checkDatabase(async () => makeDeps());
    expect(result.status).toBe('pass');
    expect(result.message).toContain('sqlite');
  });

  it('reports postgres dbType when configured', async () => {
    const result = await checkDatabase(async () => makeDeps({ getDatabaseType: () => 'postgres' }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('postgres');
  });

  // Schema vintage (#2316): a bug report has to be able to state which build
  // created the database and which last wrote to it.
  it('reports both schema vintages when recorded', async () => {
    const result = await checkDatabase(async () => makeDeps());
    expect(result.message).toContain('schema created by 0.5.3');
    expect(result.message).toContain('last applied by 0.6.0');
  });

  it('says the creation vintage is unknown rather than inventing one', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({ getSchemaVersion: async () => ({ ...schemaVersion, createdAppVersion: null }) })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('predates version tracking');
    expect(result.message).toContain('last applied by 0.6.0');
  });

  it('reports an unrecorded vintage without failing the check', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({ getSchemaVersion: async () => null })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('schema vintage not recorded');
  });

  it('stays "pass" when the vintage read throws — the database is still reachable', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({
        getSchemaVersion: async () => {
          throw new Error('no such table: remote_agent_schema_version');
        },
      })
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('reachable (sqlite)');
    expect(result.message).toContain('schema vintage not recorded');
  });

  it('returns fail with "not reachable" when query throws', async () => {
    const result = await checkDatabase(async () =>
      makeDeps({
        pool: {
          query: async () => {
            throw new Error('connection refused');
          },
        },
        getDatabaseType: () => 'postgres',
      })
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not reachable');
    expect(result.message).toContain('connection refused');
  });

  it('returns fail with "failed to load" when module load throws', async () => {
    const result = await checkDatabase(async () => {
      throw new Error('Cannot find module @archon/core');
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('failed to load database module');
    expect(result.message).toContain('Cannot find module');
  });
});

describe('checkFolderProject', () => {
  function makeDeps(over: Partial<FolderProjectDeps> = {}): FolderProjectDeps {
    return {
      findCodebaseByDefaultCwd: async () => null,
      findCodebaseByPathPrefix: async () => null,
      listChildRepos: async () => [],
      ...over,
    };
  }

  it('reports a folder project and its contained repos', async () => {
    const deps = makeDeps({
      findCodebaseByDefaultCwd: async () => ({
        name: 'platform',
        default_cwd: '/tmp/platform',
        kind: 'folder',
      }),
      listChildRepos: async () => ['auth-service', 'billing-service'],
    });

    const result = await checkFolderProject('/tmp/platform', async () => deps);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('platform');
    expect(result.message).toContain('2 contained repo(s)');
    expect(result.message).toContain('auth-service');
  });

  it('truncates the contained-repo list at 10 with a "+N more" suffix', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
    const deps = makeDeps({
      findCodebaseByPathPrefix: async () => ({
        name: 'big',
        default_cwd: '/tmp/big',
        kind: 'folder',
      }),
      listChildRepos: async () => many,
    });

    const result = await checkFolderProject('/tmp/big/subdir', async () => deps);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('14 contained repo(s)');
    expect(result.message).toContain('(+4 more)');
  });

  it('skips quietly when cwd is a repo-kind project', async () => {
    const deps = makeDeps({
      findCodebaseByDefaultCwd: async () => ({
        name: 'owner/repo',
        default_cwd: '/repos/repo',
        kind: 'repo',
      }),
    });

    const result = await checkFolderProject('/repos/repo', async () => deps);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('not a registered folder project');
  });

  it('skips quietly when cwd is unregistered', async () => {
    const result = await checkFolderProject('/tmp/random', async () => makeDeps());
    expect(result.status).toBe('skip');
  });

  it('skips (not fail) when the database lookup throws', async () => {
    const deps = makeDeps({
      findCodebaseByDefaultCwd: async () => {
        throw new Error('connection refused');
      },
    });
    const result = await checkFolderProject('/tmp/x', async () => deps);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('database unavailable');
  });

  // #2927: doctor has to ask the database the same question the CLI gate asks,
  // or it reports "not a registered folder project" for a directory every other
  // command resolves fine. It looked the raw cwd up, so any directory reached
  // through a link — or through a Windows 8.3 short path — missed.
  it('looks up the shared canonicalizer output, not the raw cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-doctor-canon-'));
    const target = join(root, 'platform');
    const link = join(root, 'platform-link');
    mkdirSync(target);
    // 'junction' is ignored on POSIX and needs no elevated privileges on Windows.
    symlinkSync(target, link, 'junction');
    const lookedUp: string[] = [];
    try {
      const deps = makeDeps({
        findCodebaseByDefaultCwd: async (cwd: string) => {
          lookedUp.push(cwd);
          return null;
        },
      });

      await checkFolderProject(link, async () => deps);

      expect(lookedUp).toEqual([await canonicalizeProjectPath(target)]);
    } finally {
      await removeTempTree(root);
    }
  });
});

describe('checkWorkspaceWritable', () => {
  const TMP = join(tmpdir(), 'archon-doctor-test-' + Date.now());
  let originalHome: string | undefined;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = TMP;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.ARCHON_HOME;
    } else {
      process.env.ARCHON_HOME = originalHome;
    }
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('returns pass when directory is writable', async () => {
    const result = await checkWorkspaceWritable();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('writable');
  });

  it('returns pass when directory does not exist (creates it)', async () => {
    rmSync(TMP, { recursive: true, force: true });
    const result = await checkWorkspaceWritable();
    expect(result.status).toBe('pass');
  });
});

describe('checkBundledDefaults', () => {
  it('returns pass with workflow and command counts in dev mode', async () => {
    const result = await checkBundledDefaults();
    expect(result.status).toBe('pass');
    expect(result.label).toBe('Bundled defaults');
    expect(result.message).toMatch(/\d+ workflow/);
    expect(result.message).toMatch(/\d+ command/);
  });
});

describe('checkSlack', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns skip when SLACK_BOT_TOKEN not set', async () => {
    const result = await checkSlack({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('SLACK_BOT_TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns pass when auth.test responds ok', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as unknown as Response
    );
    const result = await checkSlack({ SLACK_BOT_TOKEN: 'xoxb-x' });
    expect(result.status).toBe('pass');
  });

  it('returns fail when auth.test rejects with body.ok=false', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200,
      }) as unknown as Response
    );
    const result = await checkSlack({ SLACK_BOT_TOKEN: 'xoxb-x' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('invalid_auth');
  });

  it('returns skip on network error (best-effort by design)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkSlack({ SLACK_BOT_TOKEN: 'xoxb-x' });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('checkTelegram', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns skip when TELEGRAM_BOT_TOKEN not set', async () => {
    const result = await checkTelegram({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns pass when getMe responds ok', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as unknown as Response
    );
    const result = await checkTelegram({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(result.status).toBe('pass');
  });

  it('returns fail when getMe responds ok=false', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), {
        status: 401,
      }) as unknown as Response
    );
    const result = await checkTelegram({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Unauthorized');
  });

  it('returns skip on network error (best-effort by design)', async () => {
    fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await checkTelegram({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('ETIMEDOUT');
  });
});

describe('checkTelemetry', () => {
  const ENV_VARS = [
    'ARCHON_TELEMETRY_DISABLED',
    'DO_NOT_TRACK',
    'CI',
    'POSTHOG_API_KEY',
    'ARCHON_HOME',
  ] as const;
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_VARS) saved[k] = process.env[k];
    tmpHome = join(tmpdir(), `archon-doctor-tel-${process.pid}-${Date.now()}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env.ARCHON_HOME = tmpHome;
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns pass when telemetry is enabled', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const result = await checkTelemetry();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('embedded');
  });

  it('returns skip with CI reason when CI=true', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.env.CI = 'true';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('CI=true');
  });

  it('returns skip with DO_NOT_TRACK reason when opted out', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.CI;
    process.env.DO_NOT_TRACK = '1';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('DO_NOT_TRACK');
  });

  it('returns skip with POSTHOG_API_KEY reason when key set to an off value', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'off';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('POSTHOG_API_KEY');
  });

  it('returns skip with ARCHON_TELEMETRY_DISABLED reason when set', async () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('ARCHON_TELEMETRY_DISABLED');
  });
});

describe('checkArchonSkill', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'archon-doctor-skill-'));
  });

  afterEach(async () => {
    await removeTempTree(tmp);
  });

  it('skips when no skill trees are present', async () => {
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Archon skill');
  });

  it('fails when a retired skill root is still on disk', async () => {
    mkdirSync(join(tmp, '.claude', 'skills', 'archon'), { recursive: true });
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('retired skill root');
    expect(result.message).toContain('archon skill install');
  });

  it('fails when skills exist but archon-cli is missing', async () => {
    mkdirSync(join(tmp, '.claude', 'skills'), { recursive: true });
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('archon-cli is missing');
  });

  it('fails when one existing skills tree is missing archon-cli', async () => {
    await copyArchonSkill(tmp);
    await removeTempTree(join(tmp, '.agents', 'skills', 'archon-cli'));

    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain(join(tmp, '.agents', 'skills'));
  });

  it('checks only skill trees that exist', async () => {
    await copyArchonSkill(tmp);
    await removeTempTree(join(tmp, '.agents'));

    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('pass');
  });

  it('fails when an installed archon-cli differs from the bundled skill', async () => {
    await copyArchonSkill(tmp);
    writeFileSync(join(tmp, '.claude', 'skills', 'archon-cli', 'SKILL.md'), 'stale');

    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('differs from the skill bundled');
  });

  it('fails when either installed archon-cli tree contains an extra file', async () => {
    await copyArchonSkill(tmp);

    for (const root of ['.claude', '.agents']) {
      const extra = join(tmp, root, 'skills', 'archon-cli', 'retired.md');
      writeFileSync(extra, 'retired guidance');

      const result = await checkArchonSkill(tmp);
      expect(result.status).toBe('fail');
      expect(result.message).toContain(join(tmp, root, 'skills', 'archon-cli'));

      await removeTempTree(extra);
    }
  });

  it('passes when both installed copies match the bundled skill', async () => {
    await copyArchonSkill(tmp);
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('archon-cli');
  });
});

describe('doctorCommand', () => {
  let logSpy: ReturnType<typeof spyOn<Console, 'log'>>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const passing = (label: string) => async () =>
    ({ label, status: 'pass', message: 'ok' }) as const;
  const failing = (label: string) => async () =>
    ({ label, status: 'fail', message: 'broken' }) as const;
  const skipping = (label: string) => async () =>
    ({ label, status: 'skip', message: 'no token' }) as const;
  const warning = (label: string) => async () =>
    ({ label, status: 'warn', message: 'worth knowing' }) as const;
  const throwing = (label: string) => async (): Promise<never> => {
    throw new Error(`${label} blew up`);
  };

  it('returns 0 when every check passes', async () => {
    const exit = await doctorCommand([passing('A'), passing('B')]);
    expect(exit).toBe(0);
  });

  it('returns 0 when checks are pass + skip (skip is not a failure)', async () => {
    const exit = await doctorCommand([passing('A'), skipping('B')]);
    expect(exit).toBe(0);
  });

  it('returns 1 when any check fails', async () => {
    const exit = await doctorCommand([passing('A'), failing('B')]);
    expect(exit).toBe(1);
  });

  it('counts a thrown check as a failure (allSettled rejection branch)', async () => {
    const exit = await doctorCommand([passing('A'), throwing('B')]);
    expect(exit).toBe(1);
  });

  it('continues after a thrown check (Promise.allSettled does not short-circuit)', async () => {
    const exit = await doctorCommand([throwing('A'), passing('B'), failing('C')]);
    // 1 throw + 1 fail = 2 failures, but exit code is still 1.
    expect(exit).toBe(1);
    // Verify all three were rendered (one per ✓/✗/unknown line).
    const renderedLines = logSpy.mock.calls
      .map(args => String(args[0] ?? ''))
      .filter(s => s.startsWith('✓') || s.startsWith('✗') || s.startsWith('○'));
    expect(renderedLines.length).toBeGreaterThanOrEqual(2);
  });

  it('a warn is not a failure: exit 0, but it is still rendered', async () => {
    // `warn` reports a defect the operator should see on an install that
    // works (e.g. an expired-but-refreshable Pi access token). It must not
    // flip the exit code — that would break CI on healthy installs — yet it
    // must still reach the operator rather than being swallowed.
    const exit = await doctorCommand([passing('A'), warning('B')]);
    expect(exit).toBe(0);

    const warnLine = logSpy.mock.calls
      .map(args => String(args[0] ?? ''))
      .find(s => s.startsWith('!'));
    expect(warnLine).toContain('B');
    expect(warnLine).toContain('worth knowing');
  });
});

describe('checkConnectedProviders', () => {
  const mockUser = { id: 'user-1' };
  type Status = Awaited<ReturnType<ProviderDeps['getStoredCredentialStatus']>>;

  function depsWith(
    rows: { provider: string; kind: string; label: string | null }[],
    statuses: Record<string, Status> = {}
  ): () => Promise<ProviderDeps> {
    return async () => ({
      listUserProviderKeys: async () => rows,
      getStoredCredentialStatus: async (_userId, vendor) =>
        statuses[vendor] ?? { state: 'usable', source: 'archon' },
      findOrCreateUserByPlatformIdentity: async () => mockUser,
    });
  }

  it('returns skip when CLI identity is not resolvable', async () => {
    const result = await checkConnectedProviders({}, depsWith([]));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('no CLI identity');
  });

  it('returns skip with a connect hint when no providers are connected', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, depsWith([]));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('archon ai login');
  });

  it('passes with one line per credential when every credential is usable', async () => {
    const result = await checkConnectedProviders(
      { USER: 'testuser' },
      depsWith([
        { provider: 'anthropic', kind: 'oauth', label: 'subscription' },
        { provider: 'openrouter', kind: 'api_key', label: null },
      ])
    );
    expect(result.status).toBe('pass');
    expect(result.message).toBe(
      '2 connected\n    anthropic (oauth): usable\n    openrouter (api_key): usable'
    );
  });

  it('fails naming the vendor, its evidence and the reconnect command when one is unusable', async () => {
    const result = await checkConnectedProviders(
      { USER: 'testuser' },
      depsWith(
        [
          { provider: 'anthropic', kind: 'oauth', label: 'subscription' },
          { provider: 'openai', kind: 'oauth', label: null },
        ],
        {
          openai: {
            state: 'unusable',
            source: 'archon',
            evidence: 'OpenAI token refresh failed (401): invalid_grant.',
          },
          anthropic: { state: 'check_failed', source: 'archon', evidence: 'network down.' },
        }
      )
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain(
      'openai (oauth): cannot be used. Reconnect: archon ai login openai. Cause: OpenAI token refresh failed (401): invalid_grant.'
    );
  });

  it('warns when a credential could not be verified', async () => {
    const result = await checkConnectedProviders(
      { USER: 'testuser' },
      depsWith([{ provider: 'openrouter', kind: 'api_key', label: null }], {
        openrouter: { state: 'check_failed', source: 'archon', evidence: 'Request timed out.' },
      })
    );
    expect(result.status).toBe('warn');
    expect(result.message).toContain(
      'openrouter (api_key): could not be verified. If it persists, reconnect: archon ai key set openrouter. Cause: Request timed out.'
    );
  });

  it('returns skip (not fail) when loadDeps throws', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, async () => {
      throw new Error('module load failed');
    });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('module load failed');
  });

  it('returns skip (not fail) when reading credentials throws', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, async () => ({
      ...(await depsWith([{ provider: 'openrouter', kind: 'api_key', label: null }])()),
      getStoredCredentialStatus: async () => {
        throw new Error('db down');
      },
    }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('db down');
  });
});
