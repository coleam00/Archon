// @archon-test-isolated
import { afterEach, expect, mock, test } from 'bun:test';
import * as paths from '@archon/paths';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { maintainedProviderPluginId } from '@archon/plugin-manifest';
import { receiptPath } from '@archon/plugin-manifest/store';
import { trackTempRoots } from '@archon/paths/test-utils';
import { requireProvider } from '@archon/provider-contract';
import {
  claudeDescriptor,
  clearRegistry,
  getRegisteredProviders,
  providerRegistry,
} from '@archon/providers';
import { ProcessAgentProvider } from './process-provider';
mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: true }));
const { registerHostProviders } = await import('./register-host-providers');
const roots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
afterEach(() => {
  clearRegistry();
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

test('release hosts register maintained providers only from install receipts', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'binary-host-providers-')));
  process.env.ARCHON_HOME = home;
  const pluginsDir = join(home, 'plugins');
  const id = maintainedProviderPluginId('claude');
  const file = receiptPath(pluginsDir, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      id,
      manifest: {
        schemaVersion: 1,
        kind: 'provider',
        name: 'provider-claude',
        description: 'test',
        executable: 'archon-provider-claude',
      },
      tag: `v${paths.BUNDLED_VERSION}`,
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
      descriptor: claudeDescriptor,
    })
  );
  clearRegistry();
  await registerHostProviders();

  const ids = getRegisteredProviders().map(provider => provider.id);
  expect(ids.sort()).toEqual(['claude', 'copilot', 'opencode']);
  const claude = getRegisteredProviders().find(provider => provider.id === 'claude');
  expect(claude?.builtIn).toBe(true);
  const runtime = claude?.factory();
  expect(runtime).toBeInstanceOf(ProcessAgentProvider);
  expect(runtime).toMatchObject({ argv: [join(pluginsDir, 'archon-provider-claude')] });
  expect(() => requireProvider(providerRegistry, 'codex')).toThrow(
    "Provider 'codex' is not installed. Install it with: archon provider install codex"
  );
});
