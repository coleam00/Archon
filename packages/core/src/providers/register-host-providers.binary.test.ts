// @archon-test-isolated
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
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
import { clearPlatformPolicies, setPlatformPolicies } from '../platforms/registry';
import { ProcessAgentProvider } from './process-provider';

const sendQuery = spyOn(ProcessAgentProvider.prototype, 'sendQuery');
mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: true }));
const { registerHostProviders } = await import('./register-host-providers');
const { clearConfigCache, loadConfig } = await import('../config/config-loader');
const roots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
const previousAssistant = process.env.DEFAULT_AI_ASSISTANT;
afterEach(() => {
  sendQuery.mockRestore();
  clearRegistry();
  clearConfigCache();
  clearPlatformPolicies();
  if (previousAssistant === undefined) delete process.env.DEFAULT_AI_ASSISTANT;
  else process.env.DEFAULT_AI_ASSISTANT = previousAssistant;
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

test('release hosts register maintained providers only from install receipts', async () => {
  delete process.env.DEFAULT_AI_ASSISTANT;
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
  if (!runtime) throw new Error('Missing registered Claude provider');
  sendQuery.mockImplementation(async function* (this: ProcessAgentProvider) {
    expect(this).toBeInstanceOf(ProcessAgentProvider);
    expect(this).toMatchObject({ argv: [join(pluginsDir, 'archon-provider-claude')] });
    yield { type: 'result', sessionId: 'installed-claude' };
  });
  expect(await Array.fromAsync(runtime.sendQuery('prompt', '/tmp'))).toEqual([
    { type: 'result', sessionId: 'installed-claude' },
  ]);
  expect(() => requireProvider(providerRegistry, 'codex')).toThrow(
    "Provider 'codex' is not installed. Add it with: archon provider add codex"
  );
  // OpenCode and Copilot stay bundled but deprecated, so the one installed provider is the default.
  clearConfigCache();
  setPlatformPolicies([]);
  expect((await loadConfig()).assistant).toBe('claude');
});
