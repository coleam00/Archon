import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

test.skipIf(process.platform === 'win32').each([false, true])(
  'Docker startup preserves exact effective trust (newline path: %s)',
  async newlinePath => {
    const home = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-docker-safe-')));
    const bin = join(home, 'bin');
    await mkdir(bin);
    const scripts = {
      id: 'echo 1001',
      mkdir: 'exit 0',
      find: 'for arg do if [ "$arg" = -print0 ]; then printf "%s/.git\\0" "$ARCHON_TEST_REPO"; exit; fi; done; printf "%s/.git\\n" "$ARCHON_TEST_REPO"',
      bun: 'exit 0',
    };
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const repo = join(home, newlinePath ? 'repo[1]\ncheckout\n' : 'repo[1]');
    const config = join(home, newlinePath ? '.gitconfig\n' : '.gitconfig');
    const sibling = join(home, '.gitconfig');
    const siblingContents = '[test]\n\tsibling = untouched\n';
    if (newlinePath) await writeFile(sibling, siblingContents);
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      ARCHON_TEST_REPO: repo,
      ARCHON_HOME: '',
      ARCHON_DATA: '',
      GH_TOKEN: '',
      CLAUDE_BIN_PATH: process.execPath,
    };
    const git = (...args: string[]): string =>
      execFileSync('git', args, { env, encoding: 'utf8' }).trim();
    git('config', '--global', '--add', 'safe.directory', '/workspace/other');
    git('config', '--global', '--add', 'safe.directory', repo);
    git('config', '--global', '--add', 'safe.directory', repo);
    git('config', '--global', '--add', 'safe.directory', '');

    await chmod(config, 0o660);

    // Only container setup and server launch are stubbed; Git edits the scratch config.
    for (let boot = 0; boot < 2; boot++) {
      execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env });
      expect((await stat(config)).mode & 0o777).toBe(0o660);
      if (newlinePath) expect(await Bun.file(sibling).text()).toBe(siblingContents);
    }
    expect(
      execFileSync('git', ['config', '--global', '--null', '--get-all', 'safe.directory'], {
        env,
        encoding: 'utf8',
      })
        .split('\0')
        .slice(0, -1)
    ).toEqual(['/workspace/other', '', repo]);
    await mkdir(repo);
    git('init', '--quiet', repo);
    const realGit = Bun.which('git');
    if (!realGit) throw new Error('Git is required');
    const wrapper = `#!/bin/sh
if [ "$1" = config ] && [ "$2" = --global ] && [ "$3" = --null ] && [ "$4" = --get-all ]; then
  "$ARCHON_TEST_GIT" "$@" || exit $?
  "$ARCHON_TEST_GIT" config --global --fixed-value --unset-all safe.directory "$ARCHON_TEST_REPO"
  "$ARCHON_TEST_GIT" config --global --fixed-value --replace-all safe.directory "$ARCHON_TEST_REPO" "$ARCHON_TEST_REPO"
  "$ARCHON_TEST_GIT" config --global test.concurrent retained
elif [ "$5" = --unset-all ]; then
  "$ARCHON_TEST_GIT" "$@" || exit $?
  GIT_TEST_ASSUME_DIFFERENT_OWNER=1 "$ARCHON_TEST_GIT" -C "$ARCHON_TEST_REPO" status --porcelain || exit $?
  if "$ARCHON_TEST_GIT" config --global test.blocked must-not-write; then exit 88; fi
  touch "$ARCHON_TEST_MARKER"
elif [ "$5" = --replace-all ] && [ "$ARCHON_TEST_FAIL" = 1 ]; then
  echo injected-replacement-failure >&2
  exit 9
else
  exec "$ARCHON_TEST_GIT" "$@"
fi
`;
    for (const fail of [false, true]) {
      git('config', '--global', '--add', 'safe.directory', '');
      await writeFile(join(bin, 'git'), wrapper, { mode: 0o755 });
      const marker = join(home, 'checked');
      const repair = Bun.spawnSync(['bash', resolve(import.meta.dir, '../docker-entrypoint.sh')], {
        env: {
          ...env,
          ARCHON_TEST_GIT: realGit,
          ARCHON_TEST_MARKER: marker,
          ARCHON_TEST_FAIL: fail ? '1' : '0',
        },
      });
      await unlink(join(bin, 'git'));
      expect(repair.exitCode).toBe(fail ? 9 : 0);
      if (fail) expect(repair.stderr.toString()).toContain('injected-replacement-failure');
      expect(await Bun.file(marker).exists()).toBe(true);
      await unlink(marker);
      execFileSync(realGit, ['-C', repo, 'status', '--porcelain'], {
        env: { ...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
      });
      expect(git('config', '--global', 'test.concurrent')).toBe('retained');
      expect((await stat(config)).mode & 0o777).toBe(0o660);
      if (newlinePath) expect(await Bun.file(sibling).text()).toBe(siblingContents);
      expect(await Bun.file(`${config}.lock`).exists()).toBe(false);
    }
    execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env });
    await writeFile(`${config}.lock`, '');
    execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env });
    await unlink(`${config}.lock`);
    await writeFile(
      join(bin, 'find'),
      '#!/bin/sh\nprintf "%s/.git\\0" "$ARCHON_TEST_REPO"\necho scan-failed >&2\nexit 7\n',
      { mode: 0o755 }
    );
    const scan = Bun.spawnSync(['bash', resolve(import.meta.dir, '../docker-entrypoint.sh')], {
      env,
    });
    expect(scan.exitCode).toBe(7);
    expect(scan.stderr.toString()).toContain('scan-failed');
    await writeFile(join(bin, 'find'), `#!/bin/sh\n${scripts.find}\n`, { mode: 0o755 });
    git('config', '--global', '--add', 'safe.directory', repo);
    await writeFile(`${config}.lock`, '');
    expect(() =>
      execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env })
    ).toThrow();
    await unlink(`${config}.lock`);
    git('config', '--global', '--fixed-value', '--unset-all', 'safe.directory', repo);
    await writeFile(`${config}.lock`, '');
    expect(() =>
      execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env })
    ).toThrow();
  }
);
