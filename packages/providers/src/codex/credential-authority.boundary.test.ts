import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { CodexProvider } from './provider';
import { CODEX_CREDENTIAL_ENV } from './credential-env';

let root: string;
let server: ReturnType<typeof Bun.serve>;
const headers: Headers[] = [];
const part = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url');
const userToken = `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'boundary@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'user-account', chatgpt_plan_type: 'plus' } })}.sig`;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-auth-boundary-'));
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'repo'));
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/responses'))
        headers.push(request.headers);
      return Response.json(
        { error: { message: 'fixture', type: 'invalid_request_error' } },
        { status: 400 }
      );
    },
  });
  await writeFile(
    join(root, 'home', 'config.toml'),
    `
model = "stub-model"
model_provider = "stub"
chatgpt_base_url = "http://127.0.0.1:${server.port}/backend-api/"
[model_providers.stub]
name = "stub"
base_url = "http://127.0.0.1:${server.port}/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "HOST_STUB_KEY"
request_max_retries = 0
stream_max_retries = 0
http_headers = { Authorization = "Bearer configured-host", X-Project = "preserved" }
env_http_headers = { "x-api-key" = "HOST_HEADER_KEY", "X-Env" = "PROJECT_LABEL" }
`
  );
});
afterAll(async () => {
  await server?.stop(true);
  if (root) await removeTempTree(root);
});
for (const family of ['api_key', 'subscription'] as const) {
  test(
    `delivered ${family} owns HTTP authentication despite native config`,
    async () => {
      headers.length = 0;
      const delivered =
        family === 'api_key'
          ? { [CODEX_CREDENTIAL_ENV.apiKey]: 'user-key' }
          : {
              [CODEX_CREDENTIAL_ENV.chatgptAccessToken]: userToken,
              [CODEX_CREDENTIAL_ENV.chatgptAccountId]: 'user-account',
            };
      const chunks = [];
      for await (const chunk of new CodexProvider().sendQuery(
        'hello',
        join(root, 'repo'),
        undefined,
        {
          env: {
            CODEX_HOME: join(root, 'home'),
            HOST_STUB_KEY: 'host-key',
            HOST_HEADER_KEY: 'host-header-key',
            PROJECT_LABEL: 'preserved',
            [CODEX_CREDENTIAL_ENV.apiKey]: 'host-key',
            [CODEX_CREDENTIAL_ENV.chatgptAccessToken]: 'host-token',
            [CODEX_CREDENTIAL_ENV.chatgptAccountId]: 'host-account',
            ...delivered,
          },
          protectedEnvKeys: Object.keys(delivered),
          userCredentialEnvKeys: Object.keys(delivered),
          purpose: 'title-generation',
        }
      ))
        chunks.push(chunk);
      expect(headers.length, JSON.stringify(chunks)).toBeGreaterThan(0);
      expect(headers[0]?.get('authorization')).toBe(
        `Bearer ${family === 'api_key' ? 'user-key' : userToken}`
      );
      expect(headers[0]?.get('x-project')).toBe('preserved');
      expect(headers[0]?.get('x-env')).toBe('preserved');
      expect(headers[0]?.get('x-api-key')).toBeNull();
      if (family === 'subscription')
        expect(headers[0]?.get('chatgpt-account-id')).toBe('user-account');
    },
    testTimeout(30_000)
  );
}

test(
  'without delivery native provider configuration still owns authentication',
  async () => {
    headers.length = 0;
    for await (const _chunk of new CodexProvider().sendQuery(
      'hello',
      join(root, 'repo'),
      undefined,
      {
        env: {
          CODEX_HOME: join(root, 'home'),
          HOST_STUB_KEY: 'host-key',
          HOST_HEADER_KEY: 'host-header-key',
          PROJECT_LABEL: 'preserved',
          CODEX_API_KEY: 'native-key',
          ARCHON_CODEX_CHATGPT_ACCESS_TOKEN: '',
          ARCHON_CODEX_CHATGPT_ACCOUNT_ID: '',
        },
        protectedEnvKeys: ['CODEX_API_KEY'],
        purpose: 'title-generation',
      }
    )) {
    }
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]?.get('authorization')).toBe('Bearer host-key');
  },
  testTimeout(30_000)
);
