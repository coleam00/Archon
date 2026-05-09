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
  checkDatabase,
  checkGhAuth,
  checkPi,
  checkWorkspaceWritable,
  checkBundledDefaults,
  checkSlack,
  checkTelegram,
  doctorCommand,
  type DatabaseDeps,
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
