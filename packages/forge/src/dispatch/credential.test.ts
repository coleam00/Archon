import { expect, it } from 'bun:test';
import { nativeGitHubCredential } from './credential';
import { ForgeDispatcher } from './dispatcher';
import { createGitHubPlugin } from '../github/plugin';

it('preserves native user/config context without forwarding unrelated provider credentials', async () => {
  const env = {
    HOME: '/user/home',
    USERPROFILE: 'C:\\User',
    GH_CONFIG_DIR: '/user/gh',
    XDG_CONFIG_HOME: '/user/config',
    ANTHROPIC_API_KEY: 'private',
    SECRET: 'private',
  };
  const before = { ...env };
  expect(
    await nativeGitHubCredential(env, 'github.com', async (host, child) => {
      expect(host).toBe('github.com');
      expect(child).toEqual({
        HOME: env.HOME,
        USERPROFILE: env.USERPROFILE,
        GH_CONFIG_DIR: env.GH_CONFIG_DIR,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      });
      return 'native-secret\n';
    })
  ).toBe('native-secret');
  expect(env).toEqual(before);
  for (const [host, keys] of [
    ['enterprise.test', {}],
    ['github.com', { GH_TOKEN: '', GITHUB_TOKEN: '' }],
  ] as const) {
    expect(
      await nativeGitHubCredential(keys, host, async () => {
        throw new Error('must not consult native context');
      })
    ).toBeUndefined();
  }
});

it('uses host credentials only when explicit tokens are absent and redacts reflected native tokens', async () => {
  let lookups = 0;
  for (const explicit of [false, true]) {
    const plugin = createGitHubPlugin();
    const subject = new ForgeDispatcher(
      [
        {
          ...plugin,
          execOp: async (_op, _request, env) => ({
            kind: 'op_error',
            raw: { kind: 'forge_error', evidence: env.ARCHON_FORGE_TOKEN },
          }),
        },
      ],
      {
        cwd: process.cwd(),
        env: explicit ? { GH_TOKEN: 'explicit-secret' } : {},
        discoverHome: async () => [],
        discoverPath: async () => [],
        resolveCredential: async host => {
          expect(host).toBe('github.com');
          lookups++;
          return 'native-secret';
        },
      }
    );
    const result = await subject.publicOperation({
      op: 'pr.view',
      ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 1 },
    });
    expect(result).toMatchObject({
      kind: 'error',
      error: { kind: 'forge_error', evidence: '[REDACTED]' },
    });
  }
  expect(lookups).toBe(1);
});

it('never consults native auth on workflow re-entry after startup removes token keys', async () => {
  let lookups = 0;
  for (const keys of [{}, { GH_TOKEN: '' }, { GITHUB_TOKEN: '' }]) {
    expect(
      await nativeGitHubCredential(
        { ...keys, ARCHON_EXECUTABLE: '/selected/archon' },
        'github.com',
        async () => {
          lookups++;
          return 'must-not-select-native-token';
        }
      )
    ).toBeUndefined();
  }
  expect(lookups).toBe(0);
});

it('refuses known credentials and local artifact paths before public content reaches a plugin', async () => {
  const plugin = createGitHubPlugin();
  let dispatched = false;
  const subject = new ForgeDispatcher(
    [
      {
        ...plugin,
        execOp: async () => {
          dispatched = true;
          return { kind: 'ok', value: {} };
        },
      },
    ],
    {
      cwd: process.cwd(),
      env: { GH_TOKEN: 'private-token', ARTIFACTS_DIR: 'C:\\private\\artifacts' },
      discoverHome: async () => [],
      discoverPath: async () => [],
    }
  );
  for (const body of ['private-token', 'See C:/private/artifacts/report.md']) {
    expect(
      await subject.publicOperation({
        op: 'pr.edit-body',
        ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 1 },
        expected: {
          head_repo: { host: 'github.com', path: 'owner/repo' },
          head: 'feature',
          base: 'dev',
          head_sha: 'a'.repeat(40),
        },
        body,
      })
    ).toMatchObject({ kind: 'error', error: { kind: 'invalid_request' } });
  }
  expect(dispatched).toBe(false);
});
