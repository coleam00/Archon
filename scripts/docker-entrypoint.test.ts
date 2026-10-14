import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const entrypoint = fileURLToPath(new URL('../docker-entrypoint.sh', import.meta.url));
const helperKey = 'credential.https://github.com.helper';
const patHelper = '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f';
const patToken = 'entrypoint-test-pat';
const appToken = 'entrypoint-test-installation';

async function fixture(uid = '1001') {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'docker-entrypoint-')));
  const bin = join(root, 'bin');
  const configPath = join(root, 'gitconfig');
  const runnerLog = join(root, 'runner-log');
  await mkdir(bin);
  await writeFile(configPath, '');
  // Stub container operations, leaving the complete entrypoint and Git real.
  for (const [name, script] of Object.entries({
    mkdir: 'exit 0',
    find: 'exit 0',
    id: 'printf "%s\\n" "$TEST_UID"',
    bun: 'printf "entrypoint-test: %s\\n" "$*"',
    gosu: 'printf "%s:%s\\n" "$1" "$2" >> "$RUNNER_LOG"\nshift\nexec "$@"',
  })) {
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    GITHUB_APP_PRIVATE_KEY_PATH: '',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    ARCHON_HOME: '',
    ARCHON_DATA: '',
    ARCHON_ALLOW_ROOT_FALLBACK: '',
    CLAUDE_BIN_PATH: '/unused-test-claude',
    BASH_ENV: '',
    ENV: '',
    TEST_UID: uid,
    RUNNER_LOG: runnerLog,
    TEST_APP_TOKEN: appToken,
  };
  function run(command: string[], overrides: NodeJS.ProcessEnv = {}, input = '') {
    const result = Bun.spawnSync(command, {
      cwd: root,
      env: { ...env, ...overrides },
      stdin: Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }
  function git(...args: string[]) {
    const result = run(['git', ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  }
  function start(overrides: NodeJS.ProcessEnv = {}) {
    const result = run(['bash', entrypoint], overrides);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('entrypoint-test: run setup-auth\nentrypoint-test: run start\n');
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(patToken);
    expect(result.stdout).not.toContain(appToken);
  }
  function helpers() {
    const result = run(['git', 'config', '--global', '-z', '--get-all', helperKey]);
    expect([0, 1]).toContain(result.exitCode);
    return result.exitCode === 1 ? [] : result.stdout.slice(0, -1).split('\0');
  }
  return { root, configPath, runnerLog, run, git, start, helpers };
}

describe.skipIf(process.platform === 'win32')('Docker entrypoint Git credentials', () => {
  test('PAT restarts replace all previous values without persisting the token', async () => {
    const f = await fixture();
    for (const helper of ['operator-helper', '', 'another-helper']) {
      f.git('config', '--global', '--add', helperKey, helper);
    }
    for (let restart = 0; restart < 2; restart++) {
      f.start({ GH_TOKEN: patToken });
      expect(f.helpers()).toEqual([patHelper]);
      expect(await readFile(f.configPath, 'utf8')).not.toContain(patToken);
    }
  });

  test.each([
    ['1001', 'cleared'],
    ['1001', 'retained'],
    ['0', 'cleared'],
    ['0', 'retained'],
  ] as const)('PAT to App migration: UID %s, GH_TOKEN %s', async (uid, retained) => {
    const f = await fixture(uid);
    f.start({ GH_TOKEN: patToken });
    f.git('config', '--global', '--add', helperKey, patHelper);
    f.git('init', '--quiet', f.root);
    const appHelper =
      '!f() { echo "username=x-access-token"; echo "password=${TEST_APP_TOKEN}"; }; f';
    f.git('config', '--local', helperKey, appHelper);
    f.git('config', '--local', 'credential.https://github.com.useHttpPath', 'true');
    f.git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    const input = 'url=https://github.com/owner/repo.git\n\n';
    const mode = { GITHUB_APP_ID: '123', GH_TOKEN: retained === 'retained' ? patToken : '' };
    const before = f.run(['git', 'credential', 'fill'], mode, input);
    expect(before.exitCode, before.stderr).toBe(0);
    expect(before.stdout).toContain(`password=${retained === 'retained' ? patToken : ''}\n`);

    for (let restart = 0; restart < 2; restart++) {
      f.start(mode);
      expect(f.helpers()).toEqual([]);
      const credentials = f.run(['git', 'credential', 'fill'], mode, input);
      expect(credentials.exitCode, credentials.stderr).toBe(0);
      expect(credentials.stdout).toContain(`password=${appToken}\n`);
      expect(credentials.stdout).not.toContain(patToken);
      expect(credentials.stderr).toBe('');
      expect(f.git('config', '--local', '--get', helperKey).trim()).toBe(appHelper);
      expect(f.git('remote', 'get-url', 'origin').trim()).toBe('https://github.com/owner/repo.git');
      expect(await readFile(f.configPath, 'utf8')).not.toContain(patToken);
      expect(f.git('config', '--local', '--list')).not.toContain(appToken);
    }
    if (uid === '0') {
      expect((await readFile(f.runnerLog, 'utf8')).split('\n').filter(Boolean)).toEqual([
        'appuser:git',
        'appuser:bun',
        'appuser:bun',
        'appuser:git',
        'appuser:bun',
        'appuser:bun',
        'appuser:git',
        'appuser:bun',
        'appuser:bun',
      ]);
    }
  });

  test('App cleanup preserves operator helpers, empty resets, near matches and other hosts', async () => {
    const f = await fixture();
    const operatorHelpers = ['operator-helper', '', `${patHelper} `, '!echo operator'];
    for (const helper of [patHelper, ...operatorHelpers, patHelper]) {
      f.git('config', '--global', '--add', helperKey, helper);
    }
    f.git('config', '--global', 'credential.https://example.com.helper', 'other-host');
    f.git('config', '--global', 'credential.helper', 'generic-helper');
    f.start({ GITHUB_APP_ID: '123', GH_TOKEN: patToken });
    expect(f.helpers()).toEqual(operatorHelpers);
    expect(
      f.git('config', '--global', '--get', 'credential.https://example.com.helper').trim()
    ).toBe('other-host');
    expect(f.git('config', '--global', '--get', 'credential.helper').trim()).toBe('generic-helper');
    const config = await readFile(f.configPath, 'utf8');
    f.start({ GITHUB_APP_ID: '123' });
    expect(await readFile(f.configPath, 'utf8')).toBe(config);
  });

  test('App restarts succeed with no matching helper or no helper key', async () => {
    const f = await fixture();
    f.start({ GITHUB_APP_ID: '123' });
    expect(f.helpers()).toEqual([]);
    f.git('config', '--global', '--add', helperKey, 'operator-helper');
    const config = await readFile(f.configPath, 'utf8');
    f.start({ GITHUB_APP_ID: '123' });
    expect(await readFile(f.configPath, 'utf8')).toBe(config);
  });

  test('without an App ID or GH_TOKEN the persisted PAT helper remains', async () => {
    const f = await fixture();
    f.start({ GH_TOKEN: patToken });
    const config = await readFile(f.configPath, 'utf8');
    f.start();
    expect(f.helpers()).toEqual([patHelper]);
    expect(await readFile(f.configPath, 'utf8')).toBe(config);
  });

  test('App cleanup propagates malformed Git config errors before starting the server', async () => {
    const f = await fixture();
    await writeFile(f.configPath, '[broken\n');
    const result = f.run(['bash', entrypoint], { GITHUB_APP_ID: '123' });
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toContain('bad config line 1');
    expect(result.stdout).not.toContain('entrypoint-test:');
  });
});
