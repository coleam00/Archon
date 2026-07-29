/**
 * Direct coverage for installCredentialHelper.
 *
 * This behaviour used to be asserted only indirectly, from the GitHub adapter's
 * App-mode test, through the `git config` call the helper makes. That forced a
 * unit test in @archon/adapters to run the real copy into the developer's
 * `~/.archon/bin/` (#2305). The write is legitimate — it is what the function is
 * for — so it is tested here instead, at the layer that owns it, against an
 * ARCHON_HOME this file creates and removes itself.
 *
 * `execFileAsync` is stubbed with spyOn (reversible; no mock.module pollution)
 * so no real `git` process runs and the registered helper path can be asserted
 * exactly.
 *
 * KNOWN UNCOVERED BRANCH — the `skipped` discriminant
 * (`reason: 'source-script-not-on-disk'`, the compiled-binary path where
 * `scripts/` does not ship). Reaching it requires `existsSync(sourceScriptPath())`
 * to be false, and `sourceScriptPath()` resolves from `import.meta.dir` with no
 * injection seam. The only ways in are (a) `mock.module('node:fs', …)`, which is
 * process-global and irreversible in Bun and would poison every other test in
 * this package's batch, or (b) adding a parameter to production code purely for
 * testability. Neither is worth it for a branch whose entire effect is which log
 * line the caller emits. Left deliberately uncovered rather than faked.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '@archon/git';
import { installCredentialHelper } from './credential-helper-install';

describe('installCredentialHelper', () => {
  let archonHome: string;
  let originalArchonHome: string | undefined;
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  beforeEach(async () => {
    originalArchonHome = process.env.ARCHON_HOME;
    archonHome = await mkdtemp(join(tmpdir(), 'archon-credhelper-'));
    process.env.ARCHON_HOME = archonHome;
    execSpy = spyOn(git, 'execFileAsync').mockImplementation(async () => ({
      stdout: '',
      stderr: '',
    }));
  });

  afterEach(async () => {
    execSpy.mockRestore();
    if (originalArchonHome === undefined) {
      delete process.env.ARCHON_HOME;
    } else {
      process.env.ARCHON_HOME = originalArchonHome;
    }
    await rm(archonHome, { recursive: true, force: true });
  });

  test('copies the helper into $ARCHON_HOME/bin and registers it on the worktree', async () => {
    const result = await installCredentialHelper('/tmp/some-worktree');

    expect(result.kind).toBe('installed');
    const helperPath = join(archonHome, 'bin', 'git-credential-archon');
    if (result.kind !== 'installed') throw new Error('unreachable');
    expect(result.helperPath).toBe(helperPath);

    // The copy really happened, and it is the real script (not an empty file).
    const contents = await readFile(helperPath, 'utf8');
    expect(contents).toContain('git-credential');
    expect(contents.length).toBeGreaterThan(0);

    // Registered under the exact git config key the credential protocol reads.
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/some-worktree', 'config', 'credential.https://github.com.helper', helperPath],
      { timeout: 5000 }
    );
  });

  /**
   * POSIX ONLY. Windows has no execute permission bit — Node reports 0o666 for
   * every regular file there, so `mode & 0o111` is unconditionally 0 and the
   * assertion cannot hold. Asserting it unguarded is what turned windows-latest
   * red on the first push of #2307; scoping it as its own skipped test makes
   * the platform dependency visible in the run output rather than hidden inside
   * an `if` in a longer test.
   *
   * Pins the OUTCOME, not the mechanism: it holds both because copyFileSync
   * preserves the source script's 0755 and because of the explicit chmodSync,
   * so removing the chmod alone would not fail this.
   */
  test.skipIf(process.platform === 'win32')(
    'installed helper is executable (POSIX only)',
    async () => {
      const result = await installCredentialHelper('/tmp/some-worktree');
      expect(result.kind).toBe('installed');

      const helperPath = join(archonHome, 'bin', 'git-credential-archon');
      const mode = (await stat(helperPath)).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
    }
  );

  test('is idempotent — an existing helper is not overwritten but is re-registered', async () => {
    const binDir = join(archonHome, 'bin');
    await mkdir(binDir, { recursive: true });
    const helperPath = join(binDir, 'git-credential-archon');
    await writeFile(helperPath, '#!/bin/sh\n# pre-existing\n', { mode: 0o755 });

    const result = await installCredentialHelper('/tmp/another-worktree');

    expect(result.kind).toBe('installed');
    // Copy skipped: the sentinel survives.
    expect(await readFile(helperPath, 'utf8')).toContain('pre-existing');
    // Registration still runs — every cloned worktree needs its own config entry.
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/another-worktree', 'config', 'credential.https://github.com.helper', helperPath],
      { timeout: 5000 }
    );
  });

  test('returns failed instead of throwing when the git config write fails', async () => {
    execSpy.mockImplementation(() => Promise.reject(new Error('not a git repository')));

    const result = await installCredentialHelper('/tmp/not-a-repo');

    // Callers treat this as non-fatal and log it; a throw here would abort the
    // clone path for an optional convenience.
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error.message).toContain('not a git repository');
  });
});
