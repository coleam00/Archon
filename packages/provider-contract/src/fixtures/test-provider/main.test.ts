import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { connectProvider, serveProvider, type ProviderLog } from '../../plugin';
import type { IAgentProvider } from '../../agent-provider';
import type { ProviderChunk } from '../../events';
import { runProviderConformance } from '../../conformance';
import { streamPair } from '../../plugin/fixtures/streams';
import { descriptor, create, createProvider } from './main';

async function collect(provider: IAgentProvider, prompt: string): Promise<ProviderChunk[]> {
  return Array.fromAsync(provider.sendQuery(prompt, import.meta.dir));
}

async function suite(provider: IAgentProvider, stateFile: string): Promise<string[]> {
  return runProviderConformance({
    capabilities: descriptor.capabilities,
    turns: [{ name: 'echo', run: () => provider.sendQuery('echo', import.meta.dir) }],
    failureCases: [
      {
        name: 'auth',
        expected: 'auth',
        evidence: 'HTTP 401',
        run: () => provider.sendQuery('failure', import.meta.dir),
      },
    ],
    backgroundCases: [
      {
        name: 'background',
        async *run() {
          rmSync(`${stateFile}.ack`, { force: true });
          for await (const chunk of provider.sendQuery('background', import.meta.dir)) {
            yield chunk;
            if (chunk.type === 'result') writeFileSync(`${stateFile}.ack`, 'result observed');
          }
        },
        runtimeStatus: () =>
          readFileSync(stateFile, 'utf8') === 'completed' ? 'completed' : 'running',
      },
    ],
  });
}

test('test provider conforms and carries identical chunks in process, over streams and over stdio', async () => {
  const stateFile = join(tmpdir(), `archon-test-provider-${randomUUID()}`);
  const pair = streamPair();
  const serving = serveProvider(
    { descriptor, create: () => createProvider(stateFile) },
    pair.provider
  );
  const client = await connectProvider(pair.host);
  const child = spawn(process.execPath, [join(import.meta.dir, 'main.ts'), stateFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const external = await connectProvider({
    readable: Readable.toWeb(child.stdout),
    writable: Writable.toWeb(child.stdin),
  });
  try {
    for (const provider of [createProvider(stateFile), client, external])
      expect(await suite(provider, stateFile)).toEqual([]);
    for (const provider of [create(), client, external]) {
      expect(await provider.diagnose?.({ assistantConfig: { model: 'fixture/model' } })).toEqual(
        await create().diagnose?.({ assistantConfig: { model: 'fixture/model' } })
      );
      expect(await provider.listModels?.({ signal: new AbortController().signal })).toEqual(
        await create().listModels?.({ signal: new AbortController().signal })
      );
      expect(
        await Array.fromAsync(
          provider.sendQuery('structured', import.meta.dir, 'previous-session', {
            outputFormat: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: { echo: { type: 'string' } },
                required: ['echo'],
              },
            },
          })
        )
      ).toEqual([
        {
          type: 'result',
          text: 'structured',
          sessionId: 'previous-session',
          tokens: { input: 3, output: 2, total: 5 },
          structuredOutput: { echo: 'structured' },
        },
        { type: 'settled' },
      ]);
    }
    writeFileSync(`${stateFile}.ack`, 'allow parity turns');
    for (const prompt of ['echo', 'background', 'failure']) {
      const direct = await collect(create(), prompt);
      expect(await collect(client, prompt)).toEqual(direct);
      expect(await collect(external, prompt)).toEqual(direct);
    }
  } finally {
    await client.close();
    await serving;
    await external.close();
    await closed;
    rmSync(stateFile, { force: true });
    rmSync(`${stateFile}.ack`, { force: true });
  }
});

// The tracked TypeScript files under packages/*/src. Reading git's index keeps the listing
// independent of files other package suites create and delete under packages/*/src while
// this runs. CI checks out tracked files, so they are the set that has to stay clean.
function trackedSources(root: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', 'packages/*/src/**'], {
    cwd: root,
  });
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed in ${root}: ${listed.stderr.toString()}`);
  return listed.stdout
    .toString()
    .split('\0')
    .filter(file => /\.tsx?$/.test(file));
}

// Callers read synchronously. One awaited read per file took 11.8 s for ~1700 files on a
// loaded Windows runner (and hit the 20 s timeout on others); sync reads of the same files
// took 0.13 s.
function staticTestProviderImports(files: string[], read: (file: string) => string): string[] {
  return files.filter(file => {
    if (file.includes('/fixtures/test-provider/')) return false;
    const source = read(file);
    return (
      /(?:import|export)[^;]*from\s+['"][^'"]*fixtures\/test-provider[^'"]*['"]/.test(source) ||
      /import\(['"][^'"]*fixtures\/test-provider[^'"]*['"]\)/.test(source)
    );
  });
}

test('the test provider is never statically imported outside its fixture directory', () => {
  const root = join(import.meta.dir, '../../../../..');
  const files = trackedSources(root);
  // An empty or wrongly rooted listing would pass the scan below without reading anything.
  expect(files).toContain(relative(root, import.meta.path).replaceAll('\\', '/'));
  expect(staticTestProviderImports(files, file => readFileSync(join(root, file), 'utf8'))).toEqual(
    []
  );
});

test('the import scan reports static test-provider imports only outside the fixture directory', () => {
  const sources: Record<string, string> = {
    'packages/a/src/static.ts': "import { create } from '../fixtures/test-provider/main';",
    'packages/a/src/reexport.ts': "export * from './fixtures/test-provider/main';",
    'packages/a/src/dynamic.ts': "await import('./fixtures/test-provider/main');",
    'packages/a/src/clean.ts': "import { create } from './provider';",
    'packages/a/src/fixtures/test-provider/main.test.ts': "import { create } from './main';",
    'packages/a/src/fixtures/test-provider/nested.ts':
      "export * from '../../fixtures/test-provider/main';",
  };
  expect(staticTestProviderImports(Object.keys(sources), file => sources[file] ?? '')).toEqual([
    'packages/a/src/static.ts',
    'packages/a/src/reexport.ts',
    'packages/a/src/dynamic.ts',
  ]);
});

test('native tools, container env and logs have parity in process, over streams and stdio', async () => {
  const logs: ProviderLog[] = [];
  const pair = streamPair();
  const serving = serveProvider(
    { descriptor, create: log => createProvider(undefined, log) },
    pair.provider
  );
  const client = await connectProvider(pair.host, { onLog: record => logs.push(record) });
  const child = spawn(process.execPath, ['--no-env-file', join(import.meta.dir, 'main.ts')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const external = await connectProvider(
    { readable: Readable.toWeb(child.stdout), writable: Writable.toWeb(child.stdin) },
    { onLog: record => logs.push(record) }
  );
  let calls = 0;
  try {
    for (const provider of [
      createProvider(undefined, async record => {
        logs.push(record);
      }),
      client,
      external,
    ]) {
      const result = await Array.fromAsync(
        provider.sendQuery('parity', import.meta.dir, undefined, {
          execContext: { kind: 'container', containerId: 'test' },
          env: { CONTAINER_TOKEN: 'container-only' },
          nativeTools: [
            {
              name: 'inspect',
              description: 'Inspect host state',
              inputSchema: {
                properties: {
                  action: { kind: 'enum', values: ['inspect'] },
                  enabled: { kind: 'boolean' },
                },
                required: ['action'],
              },
              handler: async input => {
                expect(input).toEqual({ action: 'inspect', enabled: true });
                return `host-result-${++calls}`;
              },
            },
          ],
        })
      );
      expect(result).toEqual([
        {
          type: 'result',
          structuredOutput: {
            tool: `host-result-${calls}`,
            env: { CONTAINER_TOKEN: 'container-only' },
            hostPath: process.env.PATH ?? '',
          },
        },
        { type: 'settled' },
      ]);
    }
    expect(calls).toBe(3);
    expect(logs).toEqual(
      Array.from({ length: 3 }, () => ({
        level: 'info',
        msg: 'provider.parity',
        bindings: { transport: 'ready' },
      }))
    );
  } finally {
    await client.close();
    await serving;
    await external.close();
    await closed;
  }
});
