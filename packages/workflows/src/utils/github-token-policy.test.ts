import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { resolveGithubTokenOverrides, isOrgTokenFallbackAllowed } from './github-token-policy';

const trackTempRoot = trackTempRoots();

describe('resolveGithubTokenOverrides', () => {
  test('no-op when per-user mode is disabled (solo install)', () => {
    expect(resolveGithubTokenOverrides(false, 'user-1', 'ghu_x', {})).toEqual({});
    // even with no user token and no fallback flag
    expect(resolveGithubTokenOverrides(false, null, null, {})).toEqual({});
  });

  test('no-op for server-initiated runs (no originating userId)', () => {
    expect(resolveGithubTokenOverrides(true, null, null, {})).toEqual({});
    expect(resolveGithubTokenOverrides(true, undefined, 'ghu_x', {})).toEqual({});
  });

  test('injects the user token and clears Copilot and the host enterprise tokens', () => {
    expect(resolveGithubTokenOverrides(true, 'user-1', 'ghu_user', {})).toEqual({
      GH_TOKEN: 'ghu_user',
      GITHUB_TOKEN: 'ghu_user',
      GH_ENTERPRISE_TOKEN: '',
      GITHUB_ENTERPRISE_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
    });
  });

  test('scrubs every token and hides stored logins when the user is not connected', () => {
    const env = resolveGithubTokenOverrides(true, 'user-1', null, {});
    expect(env).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_ENTERPRISE_TOKEN: '',
      GITHUB_ENTERPRISE_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
      GH_CONFIG_DIR: expect.stringContaining('archon-gh-scrubbed-'),
      GIT_CONFIG_PARAMETERS: "'credential.helper='",
    });
    // Unique per resolution: a login written into one run's dir never reaches another.
    expect(resolveGithubTokenOverrides(true, 'user-1', null, {}).GH_CONFIG_DIR).not.toBe(
      env.GH_CONFIG_DIR
    );
  });

  test('appends the helper reset after git settings already in the environment', () => {
    const env = resolveGithubTokenOverrides(true, 'user-1', null, {
      GIT_CONFIG_PARAMETERS: "'core.autocrlf=false'",
    } as NodeJS.ProcessEnv);
    expect(env.GIT_CONFIG_PARAMETERS).toBe("'core.autocrlf=false' 'credential.helper='");
  });

  test('keeps the org token when fallback is explicitly enabled', () => {
    const env = { ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: 'true' } as NodeJS.ProcessEnv;
    expect(resolveGithubTokenOverrides(true, 'user-1', null, env)).toEqual({});
    const env1 = { ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: '1' } as NodeJS.ProcessEnv;
    expect(resolveGithubTokenOverrides(true, 'user-1', null, env1)).toEqual({});
  });
});

/**
 * The scrub against the real tools: a host that has a stored login must not lend it to a
 * scrubbed run. HOME and XDG_CONFIG_HOME point at a fixture so the test never reads the
 * machine's own gh or git login.
 */
describe('a scrubbed run against stored logins', () => {
  function hostWithStoredLogins(): NodeJS.ProcessEnv {
    const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-scrub-home-')));
    const ghConfig = join(home, '.config', 'gh');
    mkdirSync(ghConfig, { recursive: true });
    writeFileSync(
      join(ghConfig, 'hosts.yml'),
      'github.com:\n  oauth_token: gho_hoststoredlogin\n  user: host-operator\n  git_protocol: https\n'
    );
    // A helper that would hand out the host's credential, set the way `gh auth setup-git`
    // (URL-scoped) and a keychain/store helper (generic) are.
    const helper = '!f() { echo username=host-operator; echo password=hostsecret; }; f';
    writeFileSync(
      join(home, '.gitconfig'),
      `[credential]\n\thelper = "${helper}"\n[credential "https://github.com"]\n\thelper = "${helper}"\n`
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    };
    return env;
  }

  const scrubbed = (host: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...host,
    ...resolveGithubTokenOverrides(true, 'user-1', null, {}),
  });

  const hasGh = spawnSync('gh', ['--version']).status === 0;
  test.skipIf(!hasGh)('gh reports no login', () => {
    const host = hostWithStoredLogins();
    // The fixture is a real stored login: without the scrub gh uses it.
    const unscrubbed = spawnSync('gh', ['auth', 'token'], { env: host, encoding: 'utf8' });
    expect(unscrubbed.stdout.trim()).toBe('gho_hoststoredlogin');

    const result = spawnSync('gh', ['auth', 'status'], { env: scrubbed(host), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('not logged in');
  });

  test.skipIf(!hasGh)('gh does not use a host GitHub Enterprise token', () => {
    const host = {
      ...hostWithStoredLogins(),
      GH_HOST: 'ghe.example.invalid',
      GH_ENTERPRISE_TOKEN: 'ghe_host_token',
    };
    // Without the scrub gh would send the host's enterprise token.
    const unscrubbed = spawnSync('gh', ['auth', 'token', '--hostname', 'ghe.example.invalid'], {
      env: host,
      encoding: 'utf8',
    });
    expect(unscrubbed.stdout.trim()).toBe('ghe_host_token');

    const result = spawnSync('gh', ['auth', 'token', '--hostname', 'ghe.example.invalid'], {
      env: scrubbed(host),
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('git credential helpers return no password', () => {
    const fill = (env: NodeJS.ProcessEnv): string =>
      spawnSync('git', ['credential', 'fill'], {
        env,
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
      }).stdout;
    const host = hostWithStoredLogins();
    expect(fill(host)).toContain('password=hostsecret');
    expect(fill(scrubbed(host))).not.toContain('password=');
  });
});

describe('isOrgTokenFallbackAllowed', () => {
  test('true only for "true"/"1"', () => {
    expect(isOrgTokenFallbackAllowed({ ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: 'true' })).toBe(
      true
    );
    expect(isOrgTokenFallbackAllowed({ ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: '1' })).toBe(true);
    expect(isOrgTokenFallbackAllowed({ ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: 'yes' })).toBe(
      false
    );
    expect(isOrgTokenFallbackAllowed({})).toBe(false);
  });
});
