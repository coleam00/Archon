import { beforeAll, afterAll, expect, test as bunTest } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, skipCompiledBinaryTests } from '@archon/paths/test-utils';
import { dispatchForge } from './dispatch';

const skip = skipCompiledBinaryTests();
const test = bunTest.skipIf(skip);
let root: string;
let executable: string;
beforeAll(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'forge-credentials-'));
  executable = join(root, process.platform === 'win32' ? 'gh.exe' : 'gh');
  const build = Bun.spawnSync(
    [
      process.execPath,
      'build',
      '--compile',
      join(import.meta.dir, 'fixtures/credential-plugin.ts'),
      '--outfile',
      executable,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}, 60_000);
afterAll(async () => {
  if (!skip) await removeTempTree(root);
});

async function read(
  env: NodeJS.ProcessEnv,
  expected: string,
  mode = 'ok',
  tokenEnv?: string,
  path = root
) {
  writeFileSync(join(root, 'expected'), expected);
  writeFileSync(join(root, 'mode'), mode);
  writeFileSync(join(root, 'calls'), '');
  return dispatchForge(
    {
      operationId: 'credential-read',
      op: 'pr.view',
      selector: {
        kind: 'head',
        repo: { host: 'github.com', path: 'coleam00/Archon' },
        headRepo: { host: 'github.com', path: 'coleam00/Archon' },
        head: 'archon-forge-check',
      },
    },
    {
      config: {
        plugins: [{ plugin: 'github', command: executable, token_env: tokenEnv }],
        scanPath: false,
      },
      env: { PATH: path, HOME: root, GH_CONFIG_DIR: root },
      credentialEnv: env,
    }
  );
}

test.each([
  [{ GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret' }, 'gh-secret', 'GH_TOKEN'],
  [{ GH_TOKEN: 'gh-secret' }, 'gh-secret', 'GH_TOKEN'],
  [{ GITHUB_TOKEN: 'github-secret' }, 'github-secret', 'GITHUB_TOKEN'],
  [{}, 'cli-secret', 'gh auth token'],
])('selects the first available GitHub source: %j', async (env, token, source) => {
  const result = await read(env, token);
  expect(result.response.ok).toBe(true);
  expect(result).toHaveProperty('credentialSource', source);
  const calls = readFileSync(join(root, 'calls'), 'utf8');
  expect(calls).toBe(
    source === 'gh auth token' ? '["auth","token","--hostname","github.com"]\n' : ''
  );
  expect(JSON.stringify(result)).not.toContain(token);
});

test.each(['error', 'empty'])('reports a failing gh source (%s) without its output', async mode => {
  const result = await read({}, 'unused', mode);
  expect(result.response).toMatchObject({
    ok: false,
    error: {
      kind: 'process_failed',
      message: expect.stringContaining('gh auth token'),
    },
  });
  expect(JSON.stringify(result)).not.toContain('secret-from-failing-gh');
});

test('an explicitly empty credential refuses instead of borrowing the host login', async () => {
  const result = await read({ GH_TOKEN: '', GITHUB_TOKEN: '' }, 'unused');
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
  expect(readFileSync(join(root, 'calls'), 'utf8')).toBe('');
});

test('reports absent sources when gh is not installed', async () => {
  const result = await read({}, 'unused', 'ok', undefined, join(root, 'missing-bin'));
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
  expect(readFileSync(join(root, 'calls'), 'utf8')).toBe('');
});

test('does not try another source when the selected environment token is rejected', async () => {
  const result = await read(
    { GH_TOKEN: 'invalid', GITHUB_TOKEN: 'github-secret' },
    'github-secret'
  );
  expect(result.response.ok).toBe(false);
  expect(result).toHaveProperty('credentialSource', 'GH_TOKEN');
  expect(readFileSync(join(root, 'calls'), 'utf8')).toBe('');
});

test('an explicit token_env selects only that credential', async () => {
  const present = await read(
    { COMPANY_TOKEN: 'company-secret', GH_TOKEN: 'other' },
    'company-secret',
    'ok',
    'COMPANY_TOKEN'
  );
  expect(present.response.ok).toBe(true);
  expect(present).toHaveProperty('credentialSource', 'COMPANY_TOKEN');
  const missing = await read({ GH_TOKEN: 'other' }, 'unused', 'ok', 'COMPANY_TOKEN');
  expect(missing.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
  expect(readFileSync(join(root, 'calls'), 'utf8')).toBe('');
});

test('redacts a CLI token echoed by the plugin from responses and audit', async () => {
  const result = await read({}, 'leak');
  expect(result.response).toMatchObject({
    ok: false,
    error: {
      kind: 'process_failed',
      message: expect.stringContaining('[REDACTED]'),
    },
  });
  expect(JSON.stringify(result)).not.toContain('cli-secret');
});
