// @archon-test-isolated
/**
 * Installer writes stay inside a temporary ARCHON_HOME. Unit tests spy on git
 * configuration; protocol tests run real Git and the installed shell helper.
 * The packaging test checks that source and compiled installs share the asset.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { cp, mkdtemp, readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '@archon/git';
import { skipCompiledBinaryTests, trackTempRoots } from '@archon/paths/test-utils';
import { installCredentialHelper } from './credential-helper-install';
import { credentialHelperScript } from './credential-helper-script';

const trackTempRoot = trackTempRoots();

async function runHelper(
  command: string[],
  input: string,
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(input);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('installCredentialHelper', () => {
  let archonHome: string;
  let originalArchonHome: string | undefined;
  let execSpy: ReturnType<typeof spyOn<typeof git, 'execFileAsync'>>;

  beforeEach(async () => {
    originalArchonHome = process.env.ARCHON_HOME;
    archonHome = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-credhelper-')));
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
  });

  test('copies the helper into $ARCHON_HOME/bin and registers it on the worktree', async () => {
    const result = await installCredentialHelper('/tmp/some-worktree');

    expect(result.kind).toBe('installed');
    const helperPath = join(archonHome, 'bin', 'git-credential-archon');
    if (result.kind !== 'installed') throw new Error('unreachable');
    expect(result.helperPath).toBe(helperPath);

    // The bundled script was written rather than an empty placeholder.
    const contents = await readFile(helperPath, 'utf8');
    expect(contents).toContain('git-credential');
    expect(contents.length).toBeGreaterThan(0);

    // Registered under the exact git config key the credential protocol reads.
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      [
        '-C',
        '/tmp/some-worktree',
        'config',
        'credential.https://github.com.helper',
        `!'${helperPath}'`,
      ],
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
   * Pins the outcome of the explicit chmod after the bundled text is written.
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

  test('replaces an outdated helper and re-registers it on every install', async () => {
    const binDir = join(archonHome, 'bin');
    await mkdir(binDir, { recursive: true });
    const helperPath = join(binDir, 'git-credential-archon');
    await writeFile(helperPath, '#!/bin/sh\n# pre-existing\n', { mode: 0o755 });

    const oldReader = await open(helperPath, 'r');
    try {
      const result = await installCredentialHelper('/tmp/another-worktree');
      expect(result.kind).toBe('installed');
      expect(await oldReader.readFile('utf8')).toBe('#!/bin/sh\n# pre-existing\n');
    } finally {
      await oldReader.close();
    }
    expect(await readFile(helperPath, 'utf8')).toBe(credentialHelperScript);
    expect((await installCredentialHelper('/tmp/another-worktree')).kind).toBe('installed');
    expect(await readFile(helperPath, 'utf8')).toBe(credentialHelperScript);
    // Registration still runs — every cloned worktree needs its own config entry.
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      [
        '-C',
        '/tmp/another-worktree',
        'config',
        'credential.https://github.com.helper',
        `!'${helperPath}'`,
      ],
      { timeout: 5000 }
    );
  });

  test('returns failed instead of throwing when the git config write fails', async () => {
    execSpy.mockImplementation(() => Promise.reject(new Error('not a git repository')));

    const result = await installCredentialHelper('/tmp/not-a-repo');

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error.message).toContain('not a git repository');
  });

  test('returns failed when the path configuration write fails', async () => {
    execSpy.mockImplementation(async (_file, args) => {
      if (args.includes('credential.https://github.com.useHttpPath')) {
        throw new Error('path config rejected');
      }
      return { stdout: '', stderr: '' };
    });
    const result = await installCredentialHelper('/tmp/some-worktree');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error.message).toBe('path config rejected');
  });

  test.skipIf(process.platform === 'win32' || skipCompiledBinaryTests())(
    'loads from Docker source packaging and embeds in a compiled binary',
    async () => {
      execSpy.mockRestore();
      const buildRoot = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-credhelper-compiled-')));
      const entryPath = join(buildRoot, 'entry.ts');
      const binaryPath = join(buildRoot, 'credential-helper-asset');
      const packagedAuthDir = join(buildRoot, 'app', 'packages', 'core', 'src', 'github-auth');
      await cp(import.meta.dir, packagedAuthDir, { recursive: true });
      const modulePath = join(packagedAuthDir, 'credential-helper-script.ts');
      await writeFile(
        entryPath,
        `import { credentialHelperScript } from ${JSON.stringify(modulePath)};\nprocess.stdout.write(credentialHelperScript);\n`
      );

      await git.execFileAsync('bun', ['build', '--compile', '--outfile', binaryPath, entryPath], {
        timeout: 30_000,
      });
      const { stdout } = await git.execFileAsync(binaryPath, [], { timeout: 5_000 });

      expect(stdout).toContain('Git credential helper for the Archon GitHub App');
      expect(stdout).toContain('/internal/git-credential');
    }
  );

  test.skipIf(process.platform === 'win32')(
    'registered helper supplies a refreshed token to a later Git credential operation',
    async () => {
      execSpy.mockRestore();
      archonHome = join(archonHome, "with space and 'quote");
      process.env.ARCHON_HOME = archonHome;
      const repoPath = join(archonHome, 'repo');
      const fakeBin = join(archonHome, 'fake-bin');
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, 'curl'),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CURL_ARGS"\nprintf \'%s\\n\' \'{"token":"fresh-installation-token"}\'\n',
        { mode: 0o755 }
      );
      await git.execFileAsync('git', ['init', repoPath], { timeout: 5_000 });

      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await installCredentialHelper(repoPath)).kind).toBe('installed');
        const { exitCode, stdout, stderr } = await runHelper(
          ['git', '-C', repoPath, 'credential', 'fill'],
          'protocol=https\nhost=github.com\npath=owner/repo.git\n\n',
          {
            ...process.env,
            ARCHON_PORT: '43210',
            PORT: '3000',
            CURL_ARGS: join(archonHome, 'curl-args'),
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          }
        );
        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain('username=x-access-token');
        expect(stdout).toContain('password=fresh-installation-token');
        expect(stderr).toBe('');
        const curlArgs = await readFile(join(archonHome, 'curl-args'), 'utf8');
        expect(curlArgs).toContain('http://127.0.0.1:43210/internal/git-credential');
        expect(curlArgs).toContain('{"host":"github.com","path":"owner/repo.git"}');
      }
      const { stdout: config } = await git.execFileAsync('git', [
        '-C',
        repoPath,
        'config',
        '--local',
        '--list',
      ]);
      expect(config).toContain('credential.https://github.com.usehttppath=true');
      expect(config).not.toContain('fresh-installation-token');
    }
  );
  test.skipIf(process.platform === 'win32')(
    'installed helper reaches a real loopback server',
    async () => {
      execSpy.mockRestore();
      const repoPath = join(archonHome, 'repo');
      await git.execFileAsync('git', ['init', repoPath], { timeout: 5_000 });
      expect((await installCredentialHelper(repoPath)).kind).toBe('installed');
      const requests: { host: string; path: string; body: unknown }[] = [];
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          requests.push({ host: url.hostname, path: url.pathname, body: await request.json() });
          return Response.json({ token: 'loopback-test-token' });
        },
      });
      try {
        expect(server.port).not.toBe(3090);
        const { exitCode, stdout, stderr } = await runHelper(
          ['git', '-C', repoPath, 'credential', 'fill'],
          'protocol=https\nhost=github.com\npath=owner/repo\n\n',
          {
            ...process.env,
            ARCHON_PORT: String(server.port),
            PORT: '3000',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          }
        );
        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain('password=loopback-test-token');
        expect(stderr).toBe('');
        expect(requests).toEqual([
          {
            host: '127.0.0.1',
            path: '/internal/git-credential',
            body: { host: 'github.com', path: 'owner/repo' },
          },
        ]);
      } finally {
        server.stop(true);
      }
    }
  );

  test.skipIf(process.platform === 'win32')(
    'rejects invalid input before invoking curl',
    async () => {
      const result = await installCredentialHelper('/tmp/some-worktree');
      if (result.kind !== 'installed') throw result.error;
      const fakeBin = join(archonHome, 'fake-bin');
      const argsPath = join(archonHome, 'curl-args');
      await mkdir(fakeBin);
      await writeFile(
        join(fakeBin, 'curl'),
        '#!/bin/sh\nprintf called > "$CURL_ARGS"\nprintf \'%s\\n\' \'{"token":"test-token"}\'\n',
        { mode: 0o755 }
      );
      const env = {
        ...process.env,
        ARCHON_PORT: '43210',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        CURL_ARGS: argsPath,
      };
      const invalidInputs = [
        { host: 'example.com', path: 'owner/repo', port: '43210' },
        ...[
          '',
          'repo',
          'owner/repo/subpath',
          '/repo',
          'owner/',
          '.owner/repo',
          'owner/.repo',
          'owner/foo..bar',
          'foo..bar/repo',
          'owner/repo\\u002e',
          'owner/repo\",\"path\":\"victim\\u002fproject',
        ].map(path => ({ host: 'github.com', path, port: '43210' })),
        ...['', '0', '65536', '123456', '-1', '3.5', '3000/secret', 'secret-token'].map(port => ({
          host: 'github.com',
          path: 'owner/repo',
          port,
        })),
      ];
      for (const { host, path, port } of invalidInputs) {
        const { exitCode, stdout, stderr } = await runHelper(
          [result.helperPath, 'get'],
          `host=${host}\npath=${path}\n\n`,
          { ...env, ARCHON_PORT: port }
        );
        expect(exitCode).toBe(0);
        expect(stdout).toBe('');
        expect(stderr).toContain('git-credential-archon:');
        expect(stderr).not.toContain('secret');
        expect(await Bun.file(argsPath).exists()).toBe(false);
      }
      for (const action of ['store', 'erase']) {
        const { stdout, stderr } = await runHelper([result.helperPath, action], '', env);
        expect(stdout).toBe('');
        expect(stderr).toBe('');
        expect(await Bun.file(argsPath).exists()).toBe(false);
      }
      for (const path of ['owner/repo', 'owner/repo.git', 'own-er/re.po.git']) {
        const { stdout, stderr } = await runHelper(
          [result.helperPath, 'get'],
          `host=github.com\npath=${path}\n\n`,
          env
        );
        expect(stdout).toContain('password=test-token');
        expect(stderr).toBe('');
      }
      expect(await readFile(argsPath, 'utf8')).toBe('called');
    }
  );

  test.skipIf(process.platform === 'win32')(
    'transport failure does not expose curl stderr',
    async () => {
      const result = await installCredentialHelper('/tmp/some-worktree');
      if (result.kind !== 'installed') throw result.error;
      const fakeBin = join(archonHome, 'fake-bin');
      await mkdir(fakeBin);
      await writeFile(join(fakeBin, 'curl'), '#!/bin/sh\nprintf secret-token >&2\nexit 22\n', {
        mode: 0o755,
      });
      const { exitCode, stdout, stderr } = await runHelper(
        [result.helperPath, 'get'],
        'host=github.com\npath=owner/repo\n\n',
        { ...process.env, ARCHON_PORT: '43210', PATH: `${fakeBin}:${process.env.PATH ?? ''}` }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('exit 22');
      expect(stderr).not.toContain('secret-token');
    }
  );
});
