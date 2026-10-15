import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
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
      find: 'printf "%s/.git\\0" "$ARCHON_TEST_REPO"',
      bun: 'exit 0',
    };
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const repo = join(home, newlinePath ? 'repo[1]\ncheckout\n' : 'repo[1]');
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
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
    git('config', '--global', '--add', 'safe.directory', '');

    // Only container setup and server launch are stubbed; Git edits the scratch config.
    for (let boot = 0; boot < 2; boot++) {
      execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env });
    }
    expect(
      execFileSync('git', ['config', '--global', '--null', '--get-all', 'safe.directory'], {
        env,
        encoding: 'utf8',
      })
        .split('\0')
        .slice(0, -1)
    ).toEqual(['/workspace/other', '', repo]);
    await writeFile(join(home, '.gitconfig.lock'), '');
    execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env });
    await unlink(join(home, '.gitconfig.lock'));
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
    await writeFile(join(home, '.gitconfig.lock'), '');
    expect(() =>
      execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env })
    ).toThrow();
    await unlink(join(home, '.gitconfig.lock'));
    git('config', '--global', '--fixed-value', '--unset-all', 'safe.directory', repo);
    await writeFile(join(home, '.gitconfig.lock'), '');
    expect(() =>
      execFileSync('bash', [resolve(import.meta.dir, '../docker-entrypoint.sh')], { env })
    ).toThrow();
  }
);
