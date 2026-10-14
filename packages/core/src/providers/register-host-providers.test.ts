// @archon-test-isolated
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSourceProviderEntry } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { clearRegistry, getRegisteredProviders } from '@archon/providers';
import { ProcessAgentProvider } from './process-provider';
import { registerHostProviders } from './register-host-providers';

const roots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
afterEach(() => {
  clearRegistry();
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

// Docker runs from source, so this is also what the image registers.
test('source hosts register claude, codex and pi as process providers beside the bundled community providers', async () => {
  process.env.ARCHON_HOME = roots(await mkdtemp(join(tmpdir(), 'host-providers-')));
  clearRegistry();
  await registerHostProviders();
  const providers = getRegisteredProviders();
  for (const id of ['claude', 'codex', 'pi'] as const) {
    const entry = providers.find(provider => provider.id === id);
    expect(entry?.builtIn).toBe(true);
    const runtime = entry?.factory();
    expect(runtime).toBeInstanceOf(ProcessAgentProvider);
    expect(runtime).toMatchObject({
      argv: [process.execPath, '--no-env-file', getSourceProviderEntry(id)],
    });
  }
  for (const id of ['opencode', 'copilot']) {
    expect(providers.find(provider => provider.id === id)?.factory()).not.toBeInstanceOf(
      ProcessAgentProvider
    );
  }
});
