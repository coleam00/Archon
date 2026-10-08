// @archon-test-isolated
import { afterEach, expect, mock, test } from 'bun:test';
import * as paths from '@archon/paths';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { clearRegistry, getRegisteredProviders } from '@archon/providers';
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
test('release hosts retain maintained providers in process until P7', async () => {
  process.env.ARCHON_HOME = roots(await mkdtemp(join(tmpdir(), 'binary-host-providers-')));
  clearRegistry();
  await registerHostProviders();
  for (const id of MAINTAINED_PROVIDER_IDS) {
    const entry = getRegisteredProviders().find(provider => provider.id === id);
    expect(entry?.builtIn).toBe(true);
    expect(entry?.factory()).not.toBeInstanceOf(ProcessAgentProvider);
  }
});
