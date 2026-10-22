import { expect, test } from 'bun:test';
import { resolve, join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { getPluginsPath } from '@archon/paths';
import { registerProvider, clearRegistry } from '@archon/providers';
import { receiptPath } from '@archon/plugin-manifest/store';
import { loadProviderPlugins } from '@archon/core/providers/load-provider-plugins';
import { processProviderRegistration } from '@archon/core';
import { descriptor } from '../../../core/src/providers/fixtures/process-provider-data';
import { checkAssistantLogin } from './doctor-assistant-login';
import { checkProviderDiagnostics, checkInstalledProviders } from './doctor-providers';

test('doctor gets credential status through a process-backed registration', async () => {
  const registration = processProviderRegistration(descriptor, [
    process.execPath,
    resolve(import.meta.dir, '../../../core/src/providers/fixtures/process-provider.ts'),
  ]);
  const load = async () => ({
    assistant: registration.id,
    model: 'openai/model',
    vendor: 'openai',
    connectedVendors: [],
    provider: registration.factory(),
  });
  expect((await checkAssistantLogin({ TEST_CREDENTIAL: 'present-value' }, load)).status).toBe(
    'pass'
  );
  expect((await checkAssistantLogin({ TEST_CREDENTIAL: '' }, load)).status).toBe('fail');
});

test('doctor renders diagnostics returned by a registered process provider', async () => {
  const registration = processProviderRegistration(descriptor, [
    process.execPath,
    '--no-env-file',
    resolve(import.meta.dir, '../../../core/src/providers/fixtures/process-provider.ts'),
  ]);
  registerProvider(registration);
  try {
    expect(
      await checkProviderDiagnostics(registration.id, undefined, async () => ({
        assistants: { claude: {}, codex: {}, [registration.id]: { model: 'fixture/model' } },
      }))
    ).toEqual([
      {
        label: `${registration.id}: Configuration`,
        status: 'pass',
        message: 'Configuration inspected Remedy: Select a model',
      },
    ]);
  } finally {
    clearRegistry();
  }
});

test.each([
  { mode: 'no-diagnose', status: 'skip', message: 'no diagnostics hook' },
  { mode: 'information-crash', status: 'fail', message: 'request failed (RPC -32603)' },
] as const)(
  'doctor reports $mode from a process provider as $status',
  async ({ mode, status, message }) => {
    const registration = processProviderRegistration(descriptor, [
      process.execPath,
      '--no-env-file',
      resolve(import.meta.dir, '../../../core/src/providers/fixtures/process-provider.ts'),
      mode,
    ]);
    const [check] = await checkProviderDiagnostics(
      registration.id,
      registration.factory(),
      async () => ({
        assistants: { claude: {}, codex: {} },
      })
    );
    expect(check.status).toBe(status);
    expect(check.message).toContain(message);
    expect(check.message).not.toContain('private message and token');
  }
);

test('doctor reports a stale receipt with its versions and reinstall command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-doctor-stale-'));
  const savedHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = root;
  const plugins = getPluginsPath();
  const id = 'coleam00/Archon/plugins/provider-claude';
  const file = receiptPath(plugins, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      id,
      manifest: {
        schemaVersion: 1,
        kind: 'provider',
        name: 'claude',
        description: 'test',
        executable: 'archon-provider-claude',
      },
      tag: 'v0.12.0',
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
      descriptor: { ...descriptor, id: 'claude', version: '0.12.0' },
    })
  );
  try {
    expect(
      await loadProviderPlugins(plugins, { maintained: 'installed', version: '0.13.0' })
    ).toEqual([]);
    const check = await checkInstalledProviders();
    expect(check.status).toBe('fail');
    expect(check.message).toContain('installed at 0.12.0 but this CLI is 0.13.0');
    expect(check.message).toContain('archon provider add claude');
  } finally {
    clearRegistry();
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
    await removeTempTree(root);
  }
});
