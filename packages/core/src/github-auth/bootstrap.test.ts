import { afterEach, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const mint = mock(async () => 'stub-installation-credential');
const request = mock(async (route: string) => {
  if (route.startsWith('GET ')) return { data: { id: 42 } };
  return {
    data: { token: await mint(), expires_at: new Date(Date.now() + 3600000).toISOString() },
  };
});
const construct = mock(() => undefined);
mock.module('@octokit/rest', () => ({
  Octokit: class {
    constructor() {
      construct();
    }
    request = request;
  },
}));
import { loadGitHubAppConfig } from './config';
import {
  initializeWorkflowGitHubAppAuth,
  registerGitHubAppAuthProvider,
  createWorkflowDeps,
} from '../workflows/store-adapter';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  .toString();
const config = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey };
const roots: string[] = [];
afterEach(async () => {
  registerGitHubAppAuthProvider(null);
  construct.mockClear();
  mint.mockClear();
  request.mockClear();
  for (const root of roots.splice(0)) await removeTempTree(root);
});

test('absent bot configuration does not construct a provider or change dependencies', () => {
  const env = {
    GITHUB_TOKEN: 'stub-pat',
    WEBHOOK_SECRET: 'secret',
    GITHUB_APP_SLUG: 'slug',
    GITHUB_APP_INSTALLATION_ID: 'invalid',
  };
  expect(loadGitHubAppConfig(env)).toBeNull();
  expect(initializeWorkflowGitHubAppAuth(env)).toBeNull();
  expect(createWorkflowDeps().resolveBotGitHubToken).toBeUndefined();
  expect(construct).not.toHaveBeenCalled();
});

test('valid inline or file configuration needs no webhook secret and preserves inline precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-app-bootstrap-'));
  roots.push(root);
  const path = join(root, 'key.pem');
  writeFileSync(path, privateKey);
  const inline = loadGitHubAppConfig({
    ...config,
    GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll('\n', '\\n'),
    GITHUB_APP_PRIVATE_KEY_PATH: 'nonexistent',
    GITHUB_APP_INSTALLATION_ID: '42',
  });
  expect(inline?.privateKey === privateKey).toBe(true);
  expect(inline?.appId).toBe('123');
  expect(inline?.slug).toBe('archon');
  expect(inline?.defaultInstallationId).toBe(42);
  expect(loadGitHubAppConfig({ ...config, GH_TOKEN: 'ambient-fixture' })?.appId).toBe('123');
  expect(() =>
    loadGitHubAppConfig({
      ...config,
      GITHUB_APP_PRIVATE_KEY: 'invalid',
      GITHUB_APP_PRIVATE_KEY_PATH: path,
    })
  ).toThrow();
  expect(
    loadGitHubAppConfig({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: path })?.privateKey ===
      privateKey
  ).toBe(true);
});

test('partial, malformed and conflicting local configuration fails without credential diagnostics', () => {
  const badPem = '-----BEGIN PRIVATE KEY-----\ninvalid-key-sentinel\n-----END PRIVATE KEY-----';
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const invalid: NodeJS.ProcessEnv[] = [
    { GITHUB_APP_ID: '123' },
    { GITHUB_APP_PRIVATE_KEY: privateKey },
    { GITHUB_APP_PRIVATE_KEY_PATH: 'missing' },
    { GITHUB_APP_ID: ' ' },
    { ...config, GITHUB_APP_ID: '0' },
    { ...config, GITHUB_APP_ID: '1e3' },
    { ...config, GITHUB_APP_PRIVATE_KEY: badPem },
    { ...config, GITHUB_APP_PRIVATE_KEY: ec },
    { ...config, GITHUB_APP_SLUG: ' ' },
    { ...config, TOKEN_ENCRYPTION_KEY: 'invalid' },
    { ...config, GITHUB_TOKEN: 'stub-pat-sentinel' },
    ...['', '0', '-1', '1.5', '1e3', '9007199254740992'].map(GITHUB_APP_INSTALLATION_ID => ({
      ...config,
      GITHUB_APP_INSTALLATION_ID,
    })),
  ];
  for (const env of invalid) {
    let error: unknown;
    try {
      initializeWorkflowGitHubAppAuth(env);
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    const message = String(error);
    expect(
      message.includes(privateKey) ||
        message.includes(badPem) ||
        message.includes('stub-pat-sentinel')
    ).toBe(false);
    expect(createWorkflowDeps().resolveBotGitHubToken).toBeUndefined();
  }
  expect(construct).not.toHaveBeenCalled();
});

test('initialization precedes dependency snapshots, reuses the provider and mints only on resolution', async () => {
  const before = createWorkflowDeps();
  const provider = initializeWorkflowGitHubAppAuth(config);
  expect(initializeWorkflowGitHubAppAuth({})).toBe(provider);
  expect(before.resolveBotGitHubToken).toBeUndefined();
  expect(construct).toHaveBeenCalledTimes(1);
  expect(mint).not.toHaveBeenCalled();
  const deps = createWorkflowDeps();
  expect(typeof deps.resolveBotGitHubToken).toBe('function');
  expect(
    (await deps.resolveBotGitHubToken?.('owner', 'repo')) === 'stub-installation-credential'
  ).toBe(true);
  expect(mint).toHaveBeenCalledTimes(1);
});

test('provider construction failure leaves registration empty and allows a corrected retry', () => {
  construct.mockImplementationOnce(() => {
    throw new Error('Stub construction failure');
  });
  expect(() => initializeWorkflowGitHubAppAuth(config)).toThrow('Stub construction failure');
  expect(createWorkflowDeps().resolveBotGitHubToken).toBeUndefined();
  expect(initializeWorkflowGitHubAppAuth(config)).not.toBeNull();
});
