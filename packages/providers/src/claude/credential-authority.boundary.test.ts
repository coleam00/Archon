import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { buildRequestSubprocessEnv, ClaudeProvider } from './provider';
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

for (const key of ['', 'preflight-test-key']) {
  test(
    `native preflight checks Claude account without a model request (key=${Boolean(key)})`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'claude-preflight-'));
      let requests = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          requests++;
          return new Response('No model request expected', { status: 500 });
        },
      });
      try {
        const env: Record<string, string> = {
          CLAUDE_CONFIG_DIR: dir,
          ANTHROPIC_API_KEY: key,
          CLAUDE_API_KEY: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          ANTHROPIC_AUTH_TOKEN: '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        };
        for (const selector of cloudSelectors) env[selector] = '0';
        expect(
          await new ClaudeProvider().checkCredential({
            env,
            assistantConfig: { settingSources: [] },
            signal: AbortSignal.timeout(15000),
          })
        ).toEqual({ state: key ? 'usable' : 'not_connected', source: 'native' });
        expect(requests).toBe(0);
      } finally {
        server.stop(true);
        await removeTempTree(dir);
      }
    },
    testTimeout(30000)
  );
}

for (const credential of ['', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
  // Helpers are Bun scripts so the env assertions hold under cmd.exe, which does not expand $VAR.
  for (const [helper, expected] of [
    ['process.exit(1)', 'unusable'],
    ['', 'unusable'],
    [
      "process.env.PREFLIGHT_HELPER_KEY === 'helper-key' && process.stdout.write('helper-key')",
      'usable',
    ],
    [
      "process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts' && !process.env.NODE_OPTIONS && process.stdout.write('helper-key')",
      'usable',
    ],
    [
      "process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' && process.stdout.write('helper-key')",
      'unusable',
    ],
  ] as const) {
    test(
      `native preflight resolves apiKeyHelper: ${helper || '(no output)'} with ${credential || 'no env key'}`,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'claude-helper-preflight-'));
        try {
          const script = join(dir, 'helper.js');
          await writeFile(script, helper);
          await writeFile(
            join(dir, 'settings.json'),
            JSON.stringify({
              apiKeyHelper: `"${process.execPath}" "${script}"`,
              env: { PREFLIGHT_HELPER_KEY: 'helper-key' },
            })
          );
          const env: Record<string, string> = {
            CLAUDE_CONFIG_DIR: dir,
            ANTHROPIC_API_KEY: '',
            CLAUDE_API_KEY: '',
            CLAUDE_CODE_OAUTH_TOKEN: '',
            ANTHROPIC_AUTH_TOKEN: '',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          };
          env.NODE_OPTIONS = '--no-warnings';
          env.CLAUDE_CODE_ENTRYPOINT = '';
          if (credential) env[credential] = 'environment-key';
          for (const selector of cloudSelectors) env[selector] = '0';
          const status = await new ClaudeProvider().checkCredential({
            env,
            assistantConfig: { settingSources: ['user'] },
            signal: AbortSignal.timeout(15000),
          });
          expect(status.state).toBe(credential ? 'usable' : expected);
          if (status.state === 'unusable') expect(status.evidence).toContain('apiKeyHelper');
        } finally {
          await removeTempTree(dir);
        }
      },
      testTimeout(30000)
    );
  }
}

test(
  'native preflight uses target cwd and node setting sources over assistant defaults',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-project-preflight-'));
    try {
      const project = join(dir, 'project');
      await mkdir(join(project, '.claude'), { recursive: true });
      const script = join(dir, 'helper.js');
      await writeFile(
        script,
        "const { existsSync } = require('node:fs');\nif (existsSync('.claude/settings.json')) process.stdout.write('project-key');\n"
      );
      await writeFile(
        join(project, '.claude/settings.json'),
        JSON.stringify({ apiKeyHelper: `"${process.execPath}" "${script}"` })
      );
      const env: Record<string, string> = {
        CLAUDE_CONFIG_DIR: dir,
        ANTHROPIC_API_KEY: '',
        CLAUDE_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };
      for (const selector of cloudSelectors) env[selector] = '0';
      const provider = new ClaudeProvider();
      const request = {
        env,
        cwd: project,
        assistantConfig: { settingSources: [] },
        signal: AbortSignal.timeout(15000),
      };
      expect(await provider.checkCredential(request)).toEqual({
        state: 'not_connected',
        source: 'native',
      });
      expect(await provider.checkCredential({ ...request, settingSources: ['project'] })).toEqual({
        state: 'usable',
        source: 'native',
      });
      expect(
        await provider.checkCredential({ ...request, cwd: dir, settingSources: ['project'] })
      ).toEqual({ state: 'not_connected', source: 'native' });
    } finally {
      await removeTempTree(dir);
    }
  },
  testTimeout(30000)
);
