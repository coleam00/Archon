import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('the test provider is never statically imported outside its fixture directory', async () => {
  const root = join(import.meta.dir, '../../../../..');
  for await (const file of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scan({
    cwd: root,
    onlyFiles: true,
  })) {
    if (file.replaceAll('\\', '/').includes('/fixtures/test-provider/')) continue;
    const source = await Bun.file(join(root, file)).text();
    expect(source).not.toMatch(
      /(?:import|export)[^;]*from\s+['"][^'"]*fixtures\/test-provider[^'"]*['"]/
    );
    expect(source).not.toMatch(/import\(['"][^'"]*fixtures\/test-provider[^'"]*['"]\)/);
  }
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
