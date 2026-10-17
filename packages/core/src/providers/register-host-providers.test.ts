// @archon-test-isolated
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSourceProviderEntry } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { clearRegistry, getRegisteredProviders } from '@archon/providers';
import { CopilotProvider } from '@archon/providers/community/copilot';
import { OpencodeProvider } from '@archon/providers/community/opencode';
import { ProcessAgentProvider } from './process-provider';
import { registerHostProviders } from './register-host-providers';

const sendQuery = spyOn(ProcessAgentProvider.prototype, 'sendQuery');

const roots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
afterEach(() => {
  sendQuery.mockRestore();
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
    if (!runtime) throw new Error(`Missing registered provider: ${id}`);
    sendQuery.mockImplementation(async function* (this: ProcessAgentProvider) {
      expect(this).toBeInstanceOf(ProcessAgentProvider);
      expect(this).toMatchObject({
        argv: [process.execPath, '--no-env-file', getSourceProviderEntry(id)],
      });
      yield { type: 'result', sessionId: id };
    });
    expect(await Array.fromAsync(runtime.sendQuery('prompt', '/tmp'))).toEqual([
      { type: 'result', sessionId: id },
    ]);
  }
  for (const [id, Provider] of [
    ['opencode', OpencodeProvider],
    ['copilot', CopilotProvider],
  ] as const) {
    const query = spyOn(Provider.prototype, 'sendQuery').mockImplementation(async function* (
      this: OpencodeProvider | CopilotProvider
    ) {
      expect(this).toBeInstanceOf(Provider);
      yield { type: 'result', sessionId: id };
    });
    try {
      const runtime = providers.find(provider => provider.id === id)?.factory();
      if (!runtime) throw new Error(`Missing registered provider: ${id}`);
      expect(await Array.fromAsync(runtime.sendQuery('prompt', '/tmp'))).toEqual([
        { type: 'result', sessionId: id },
      ]);
    } finally {
      query.mockRestore();
    }
  }
});
