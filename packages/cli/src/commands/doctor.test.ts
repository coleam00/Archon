/**
 * Tests for `archon doctor` check functions.
 *
 * Uses spyOn for `@archon/git.execFileAsync` and `@archon/paths.BUNDLED_IS_BINARY`
 * indirection. Avoids `mock.module()` because it is process-global and
 * irreversible in Bun, which would pollute other test files in this package.
 */
import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as git from '@archon/git';
import {
  checkClaudeBinary,
  checkGhAuth,
  checkWorkspaceWritable,
  checkSlack,
  checkTelegram,
} from './doctor';

describe('checkClaudeBinary', () => {
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it('returns skip in dev mode (BUNDLED_IS_BINARY=false)', async () => {
    // The default test environment has BUNDLED_IS_BINARY=false (set by
    // packages/paths/src/bundled-build.ts and only flipped during the binary
    // build). No spy needed — we exercise the dev-mode branch.
    const result = await checkClaudeBinary({});
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Claude binary');
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
    // Should NOT have called execFileAsync — skip is short-circuit.
    expect(execSpy).not.toHaveBeenCalled();
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

describe('checkSlack', () => {
  it('returns skip when SLACK_BOT_TOKEN not set', async () => {
    const result = await checkSlack({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('SLACK_BOT_TOKEN');
  });
});

describe('checkTelegram', () => {
  it('returns skip when TELEGRAM_BOT_TOKEN not set', async () => {
    const result = await checkTelegram({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('TELEGRAM_BOT_TOKEN');
  });
});
