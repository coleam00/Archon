// @archon-test-isolated
import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '@archon/paths';
import { MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { trackTempRoots } from '@archon/paths/test-utils';
import { clearRegistry, getRegisteredProviders, maintainedDescriptors } from '@archon/providers';
import { CopilotProvider } from '@archon/providers/community/copilot';
import { OpencodeProvider } from '@archon/providers/community/opencode';
import { registerHostProviders } from './register-host-providers';

const sourceEntry = spyOn(paths, 'getSourceProviderEntry');

const roots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
afterEach(() => {
  sourceEntry.mockRestore();
  clearRegistry();
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

// Docker runs from source, so this is also what the image registers.
test('source hosts refuse changed built-in descriptors with run resume advice beside the bundled community providers', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'host-providers-')));
  process.env.ARCHON_HOME = home;
  const session = join(home, 'session');
  const canary = `ARCHON_SOURCE_DOTENV_${randomUUID().replaceAll('-', '_')}`;
  await writeFile(join(home, '.env'), `${canary}=loaded_from_dotenv\n`);
  for (const id of MAINTAINED_PROVIDER_IDS) {
    await writeFile(
      join(home, `${id}.ts`),
      `import { writeFileSync } from 'node:fs';
import { serveProvider } from ${JSON.stringify(import.meta.resolve('@archon/provider-contract/plugin'))};
writeFileSync(${JSON.stringify(join(home, `${id}.env.json`))}, JSON.stringify(Object.hasOwn(process.env, ${JSON.stringify(canary)})));
await serveProvider({
  descriptor: ${JSON.stringify({ ...maintainedDescriptors[id], version: 'changed' })},
  create() {
    writeFileSync(${JSON.stringify(session)}, 'session started');
    throw new Error('Unexpected provider session');
  },
});
`
    );
  }
  sourceEntry.mockImplementation(id => join(home, `${id}.ts`));
  clearRegistry();
  await registerHostProviders();
  const providers = getRegisteredProviders();
  const runId = '15454d16-0000-4000-8000-000000000001';
  const previousCwd = process.cwd();
  process.chdir(home);
  try {
    for (const id of MAINTAINED_PROVIDER_IDS) {
      const entry = providers.find(provider => provider.id === id);
      expect(entry?.builtIn).toBe(true);
      const runtime = entry?.factory();
      if (!runtime) throw new Error(`Missing registered provider: ${id}`);
      await expect(
        Array.fromAsync(
          runtime.sendQuery('prompt', tmpdir(), undefined, { env: { WORKFLOW_ID: runId } })
        )
      ).rejects.toEqual(
        new Error(
          `Archon's source changed under this run (built-in provider ${id}); the run can continue with archon workflow resume ${runId}`
        )
      );
      expect(existsSync(session)).toBe(false);
      expect(JSON.parse(readFileSync(join(home, `${id}.env.json`), 'utf8'))).toBe(false);
    }
  } finally {
    process.chdir(previousCwd);
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
