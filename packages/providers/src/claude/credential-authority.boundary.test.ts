import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { buildRequestSubprocessEnv } from './provider';
import { resolveBundledClaudeBinary } from './plugins';

for (const credential of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const) {
  test(
    `delivered ${credential} owns native authentication with competing settings`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-auth-boundary-'));
      try {
        const binary = resolveBundledClaudeBinary();
        expect(binary).toBeDefined();
        if (!binary) throw new Error('Missing bundled Claude');
        await writeFile(
          join(dir, 'settings.json'),
          JSON.stringify({
            env: { ANTHROPIC_API_KEY: 'project-key', CLAUDE_CODE_OAUTH_TOKEN: 'project-token' },
            apiKeyHelper: 'echo host-helper-key',
          })
        );
        const env = buildRequestSubprocessEnv({
          env: {
            CLAUDE_CONFIG_DIR: dir,
            ANTHROPIC_API_KEY: 'host-key',
            CLAUDE_CODE_OAUTH_TOKEN: 'host-token',
            ANTHROPIC_AUTH_TOKEN: 'host-bearer',
            CLAUDE_CODE_USE_BEDROCK: '1',
            CLAUDE_CODE_USE_VERTEX: '1',
            CLAUDE_CODE_USE_FOUNDRY: '1',
            [credential]: 'user-credential',
          },
          protectedEnvKeys: [credential],
        });
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env[credential]).toBe('user-credential');
        const child = Bun.spawn(
          [binary, '--settings', JSON.stringify({ apiKeyHelper: '' }), 'auth', 'status', '--json'],
          {
            cwd: dir,
            env,
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        const output = (await new Response(child.stdout).json()) as {
          authMethod: string;
          apiProvider: string;
        };
        expect(await child.exited).toBe(0);
        expect(output.authMethod).toBe(
          credential === 'ANTHROPIC_API_KEY' ? 'api_key' : 'oauth_token'
        );
        expect(output.apiProvider).toBe('firstParty');
      } finally {
        await removeTempTree(dir);
      }
    },
    testTimeout(30_000)
  );
}
test('unrelated protection keeps native credential precedence', () => {
  const env = buildRequestSubprocessEnv({
    env: { ANTHROPIC_API_KEY: 'native-key', CLAUDE_CODE_OAUTH_TOKEN: 'native-token' },
    protectedEnvKeys: ['GIT_AUTHOR_NAME'],
  });
  expect(env.ANTHROPIC_API_KEY).toBe('native-key');
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('native-token');
});
