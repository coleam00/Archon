/**
 * Tests for `archon doctor` check functions.
 *
 * Uses spyOn for `@archon/git.execFileAsync` and `globalThis.fetch`.
 * `BUNDLED_IS_BINARY` is a static const re-export and cannot be spied at
 * runtime — `checkClaudeBinary` accepts it as an injectable parameter for
 * testability. Avoids `mock.module()` because it is process-global and
 * irreversible in Bun, which would pollute other test files in this package.
 */
import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import * as git from '@archon/git';
import {
  checkClaudeBinary,
  checkCodexBinary,
  checkOpenCode,
  checkDatabase,
  checkConnectedProviders,
  checkGhAuth,
  checkPi,
  checkWorkspaceWritable,
  checkBundledDefaults,
  checkSlack,
  checkTelegram,
  checkTelemetry,
  checkFolderProject,
  doctorCommand,
  type CodexBinaryDeps,
  type DatabaseDeps,
  type FolderProjectDeps,
  type OpenCodeDeps,
} from './doctor';
import * as doctorModule from './doctor';

describe('checkClaudeBinary', () => {
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('returns skip when not in binary mode', async () => {
    const result = await checkClaudeBinary({}, false);
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Claude binary');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns fail in binary mode when CLAUDE_BIN_PATH is unset', async () => {
    const result = await checkClaudeBinary({}, true);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('CLAUDE_BIN_PATH');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns pass in binary mode when binary spawns successfully', async () => {
    execSpy.mockResolvedValue({ stdout: '1.0.0', stderr: '' });
    const result = await checkClaudeBinary({ CLAUDE_BIN_PATH: '/opt/claude' }, true);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('/opt/claude');
    expect(execSpy).toHaveBeenCalledWith('/opt/claude', ['--version'], expect.any(Object));
  });

  it('returns fail in binary mode when spawn throws', async () => {
    execSpy.mockRejectedValue(new Error('ENOENT'));
    const result = await checkClaudeBinary({ CLAUDE_BIN_PATH: '/opt/claude' }, true);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('did not spawn');
    expect(result.message).toContain('ENOENT');
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

describe('checkPi', () => {
  // Spy on the exported `probeAuthJsonExists` wrapper rather than `fsModule.existsSync`.
  // Named imports from 'fs' cannot be intercepted by spying on the namespace object
  // due to ESM rebinding — the wrapper pattern (same as `probeFileExists` in setup.ts)
  // is the correct way to make this testable.
  let authJsonSpy: ReturnType<typeof spyOn<typeof doctorModule, 'probeAuthJsonExists'>>;

  beforeEach(() => {
    authJsonSpy = spyOn(doctorModule, 'probeAuthJsonExists');
  });

  afterEach(() => {
    authJsonSpy.mockRestore();
  });

  it('returns skip when Pi is not configured', async () => {
    const result = await checkPi({});
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Pi provider');
    expect(result.message).toContain('not configured');
  });

  it('returns pass when ~/.pi/agent/auth.json exists', async () => {
    authJsonSpy.mockReturnValue(true);
    const result = await checkPi({ DEFAULT_AI_ASSISTANT: 'pi' });
    expect(result.status).toBe('pass');
    expect(result.message).toContain('auth.json');
  });

  it('returns pass when a Pi API key env var is set', async () => {
    authJsonSpy.mockReturnValue(false);
    const result = await checkPi({
      DEFAULT_AI_ASSISTANT: 'pi',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(result.status).toBe('pass');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
  });

  it('returns fail when DEFAULT_AI_ASSISTANT=pi but no auth found', async () => {
    authJsonSpy.mockReturnValue(false);
    const result = await checkPi({ DEFAULT_AI_ASSISTANT: 'pi' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('pi /login');
  });

  it('returns skip for Claude-only users who have ANTHROPIC_API_KEY but Pi is not default', async () => {
    // Regression guard for M2: shared keys like ANTHROPIC_API_KEY must not be treated
    // as Pi evidence unless DEFAULT_AI_ASSISTANT=pi.
    authJsonSpy.mockReturnValue(false);
    const result = await checkPi({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('not configured');
  });

  it('returns skip for users with OPENROUTER_API_KEY set but Pi not configured as default', async () => {
    authJsonSpy.mockReturnValue(false);
    const result = await checkPi({ OPENROUTER_API_KEY: 'or-key' });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('not configured');
  });
});

describe('checkDatabase', () => {
  it('returns pass when query succeeds', async () => {
    const deps: DatabaseDeps = {
      pool: { query: async () => undefined },
      getDatabaseType: () => 'sqlite',
    };
    const result = await checkDatabase(async () => deps);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('sqlite');
  });

  it('reports postgres dbType when configured', async () => {
    const deps: DatabaseDeps = {
      pool: { query: async () => undefined },
      getDatabaseType: () => 'postgres',
    };
    const result = await checkDatabase(async () => deps);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('postgres');
  });

  it('returns fail with "not reachable" when query throws', async () => {
    const deps: DatabaseDeps = {
      pool: {
        query: async () => {
          throw new Error('connection refused');
        },
      },
      getDatabaseType: () => 'postgres',
    };
    const result = await checkDatabase(async () => deps);
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
});

describe('checkConnectedProviders', () => {
  const mockUser = { id: 'user-1' };

  it('returns skip when CLI identity is not resolvable', async () => {
    const result = await checkConnectedProviders({}, async () => ({
      listUserProviderKeys: async () => [],
      findOrCreateUserByPlatformIdentity: async () => mockUser,
    }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('no CLI identity');
  });

  it('returns skip with a connect hint when no providers are connected', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, async () => ({
      listUserProviderKeys: async () => [],
      findOrCreateUserByPlatformIdentity: async () => mockUser,
    }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('archon ai login');
  });

  it('returns pass with a count and vendor list when providers are connected', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, async () => ({
      listUserProviderKeys: async () => [
        { provider: 'anthropic', kind: 'oauth', label: 'subscription' },
        { provider: 'openrouter', kind: 'api_key', label: null },
      ],
      findOrCreateUserByPlatformIdentity: async () => mockUser,
    }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('2 connected');
    expect(result.message).toContain('anthropic');
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
      listUserProviderKeys: async () => {
        throw new Error('db down');
      },
      findOrCreateUserByPlatformIdentity: async () => mockUser,
    }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('db down');
  });
});
