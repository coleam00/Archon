import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { buildRequestSubprocessEnv } from './provider';
import { resolveBundledClaudeBinary } from './plugins';

const cloudSelectors = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
] as const;

for (const selector of cloudSelectors) {
  for (const credential of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const) {
    test(
      `delivered ${credential} owns native authentication against ${selector}`,
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
              [selector]: '1',
              [credential]: 'user-credential',
            },
            protectedEnvKeys: [credential],
            userCredentialEnvKeys: [credential],
          });
          expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
          expect(env[credential]).toBe('user-credential');
          const child = Bun.spawn(
            [
              binary,
              '--settings',
              JSON.stringify({ apiKeyHelper: '' }),
              'auth',
              'status',
              '--json',
            ],
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
}
test('unrelated protection keeps native credential precedence', () => {
  const env = buildRequestSubprocessEnv({
    env: { ANTHROPIC_API_KEY: 'native-key', CLAUDE_CODE_OAUTH_TOKEN: 'native-token' },
    protectedEnvKeys: ['GIT_AUTHOR_NAME'],
  });
  expect(env.ANTHROPIC_API_KEY).toBe('native-key');
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('native-token');
});

for (const protectedKey of ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  test(`protected native ${protectedKey} does not imply per-user delivery`, () => {
    const env = buildRequestSubprocessEnv({
      env: {
        ANTHROPIC_API_KEY: 'native-key',
        CLAUDE_API_KEY: 'native-alias',
        CLAUDE_CODE_OAUTH_TOKEN: 'native-token',
        CLAUDE_CODE_USE_MANTLE: '1',
      },
      protectedEnvKeys: [protectedKey],
    });
    expect(env.ANTHROPIC_API_KEY).toBe('native-key');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('native-token');
    expect(env.CLAUDE_CODE_USE_MANTLE).toBe('1');
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).not.toBe('1');
  });
}

for (const selector of ['CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']) {
  for (const credential of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    test(
      `delivered ${credential} prevents operator AWS signing through ${selector}`,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'claude-http-auth-'));
        const headers: Headers[] = [];
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch(request) {
            if (request.method === 'POST') headers.push(request.headers);
            return Response.json(
              { error: { type: 'invalid_request_error', message: 'fixture' } },
              { status: 400 }
            );
          },
        });
        try {
          const binary = resolveBundledClaudeBinary();
          if (!binary) throw new Error('Missing bundled Claude');
          const baseUrl = `http://127.0.0.1:${server.port}`;
          const env = buildRequestSubprocessEnv({
            env: {
              CLAUDE_CONFIG_DIR: dir,
              ANTHROPIC_BASE_URL: baseUrl,
              ANTHROPIC_BEDROCK_MANTLE_BASE_URL: baseUrl,
              ANTHROPIC_AWS_WORKSPACE_ID: 'fixture',
              ANTHROPIC_AWS_BASE_URL: baseUrl,
              AWS_ACCESS_KEY_ID: 'OPERATORACCESSKEY',
              AWS_SECRET_ACCESS_KEY: 'operator-secret',
              AWS_REGION: 'us-east-1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              [selector]: '1',
              [credential]: 'user-credential',
            },
            protectedEnvKeys: [credential],
            userCredentialEnvKeys: [credential],
          });
          const child = Bun.spawn(
            [
              binary,
              '-p',
              'hello',
              '--model',
              'claude-sonnet-4-5',
              '--no-session-persistence',
              '--settings',
              JSON.stringify({ apiKeyHelper: '' }),
            ],
            { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' }
          );
          const timeout = setTimeout(() => child.kill(), 15_000);
          try {
            const output = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            expect(headers.length, JSON.stringify(output)).toBeGreaterThan(0);
            for (const header of headers) {
              expect(header.get('authorization') ?? '').not.toContain('AWS4-HMAC-SHA256');
              if (credential === 'ANTHROPIC_API_KEY')
                expect(header.get('x-api-key')).toBe('user-credential');
              else expect(header.get('authorization')).toBe('Bearer user-credential');
            }
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          await server.stop(true);
          await removeTempTree(dir);
        }
      },
      testTimeout(20_000)
    );
  }
}
