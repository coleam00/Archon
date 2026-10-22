import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { removeTempTree } from '@archon/paths/test-utils';
import { checkGitHubApp, checkSlack, checkTelegram } from './doctor-platforms';
import { doctorCommand } from './doctor';

describe('checkGitHubApp', () => {
  let execSpy: ReturnType<typeof spyOn<typeof Bun, 'spawnSync'>>;

  beforeEach(() => {
    execSpy = spyOn(Bun, 'spawnSync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

  it('validates App inline and file keys locally without gh or remote access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-app-'));
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
    try {
      const keyPath = join(root, 'app.pem');
      writeFileSync(keyPath, privateKey);
      for (const keyEnv of [
        { GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll('\n', '\\n') },
        { GITHUB_APP_PRIVATE_KEY_PATH: keyPath },
      ]) {
        expect(await checkGitHubApp({ GITHUB_APP_ID: '123', ...keyEnv })).toEqual({
          label: 'GitHub App',
          status: 'pass',
          message: 'App mode configured (local configuration valid; GitHub access not checked)',
        });
      }
      expect(execSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await removeTempTree(root);
    }
  });

  it('reports incomplete, invalid and conflicting App configuration without exposing secrets', async () => {
    for (const env of [
      { GITHUB_APP_ID: '123' },
      { GITHUB_APP_PRIVATE_KEY: privateKey },
      { GITHUB_APP_ID: 'invalid', GITHUB_APP_PRIVATE_KEY: privateKey },
      { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'bad-private-key-secret' },
      {
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----',
      },
      { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: '/missing/archon-key.pem' },
      { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_TOKEN: 'pat-secret' },
    ]) {
      const result = await checkGitHubApp(env);
      expect(result.label).toBe('GitHub App');
      expect(result.status).toBe('fail');
      expect(result.message).not.toContain(privateKey);
      expect(result.message).not.toContain('pat-secret');
      expect(result.message).not.toContain('bad-private-key-secret');
    }
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('does not print a private key pasted into GITHUB_APP_PRIVATE_KEY_PATH', async () => {
    const sentinel = 'sentinel-private-key-material';
    const pastedKey = `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----`;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await doctorCommand([
          () => checkGitHubApp({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: pastedKey }),
        ])
      ).toBe(1);
      const printed = JSON.stringify([log.mock.calls, error.mock.calls]);
      expect(printed).toContain('GITHUB_APP_PRIVATE_KEY_PATH');
      expect(printed).not.toContain(sentinel);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('renders App results and returns the corresponding doctor exit status', async () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await doctorCommand([
          () => checkGitHubApp({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey }),
        ])
      ).toBe(0);
      expect(JSON.stringify(output.mock.calls)).toContain('GitHub App');
      expect(await doctorCommand([() => checkGitHubApp({ GITHUB_APP_ID: '123' })])).toBe(1);
      expect(JSON.stringify(output.mock.calls)).not.toContain(privateKey);
    } finally {
      output.mockRestore();
    }
  });
});

describe('checkSlack', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns skip when SLACK_BOT_TOKEN not set', async () => {
    const result = await checkSlack({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('SLACK_BOT_TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns pass when auth.test responds ok', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as unknown as Response
    );
    const result = await checkSlack({ SLACK_BOT_TOKEN: 'xoxb-x' });
    expect(result.status).toBe('pass');
  });

  it('returns fail when auth.test rejects with body.ok=false', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200,
      }) as unknown as Response
    );
    const result = await checkSlack({ SLACK_BOT_TOKEN: 'xoxb-x' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('invalid_auth');
  });

  it('returns skip on network error (best-effort by design)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkSlack({ SLACK_BOT_TOKEN: 'xoxb-x' });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('checkTelegram', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns skip when TELEGRAM_BOT_TOKEN not set', async () => {
    const result = await checkTelegram({});
    expect(result.status).toBe('skip');
    expect(result.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns pass when getMe responds ok', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as unknown as Response
    );
    const result = await checkTelegram({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(result.status).toBe('pass');
  });

  it('returns fail when getMe responds ok=false', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), {
        status: 401,
      }) as unknown as Response
    );
    const result = await checkTelegram({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Unauthorized');
  });

  it('returns skip on network error (best-effort by design)', async () => {
    fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await checkTelegram({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('ETIMEDOUT');
  });
});
