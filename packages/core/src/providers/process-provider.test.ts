import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '@archon/paths';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { buildProviderSubprocessEnv, type ProviderChunk } from '@archon/provider-contract';
import { runProviderConformance } from '@archon/provider-contract/conformance';
import { ProviderPluginExitedError } from './process-provider';
import { processProviderRegistration } from './process-registration';
import { descriptor, chunks } from './fixtures/process-provider-data';

const processLog = paths.createLogger('core.provider-process');
const realCreateLogger = paths.createLogger;
spyOn(paths, 'createLogger').mockImplementation(module =>
  module === 'core.provider-process' ? processLog : realCreateLogger(module)
);

const fixture = join(import.meta.dir, 'fixtures/process-provider.ts');
const provider = (mode = 'normal', path?: string) =>
  processProviderRegistration(descriptor, [
    process.execPath,
    fixture,
    mode,
    ...(path ? [path] : []),
  ]).factory();
async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const output: ProviderChunk[] = [];
  for await (const chunk of stream) output.push(chunk);
  return output;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('registration runs a real process, preserving chunks and exiting after settled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'archon-provider-complete-'));
  try {
    const file = join(directory, 'pid');
    expect(await collect(provider('record-pid', file).sendQuery('turn', tmpdir()))).toEqual(chunks);
    expect(alive(Number(readFileSync(file, 'utf8')))).toBe(false);
  } finally {
    await removeTempTree(directory);
  }
});

test('process conforms, including real background state and typed failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'archon-provider-background-'));
  const file = join(directory, 'state');
  const turn = { name: 'process turn', run: () => provider().sendQuery('turn', tmpdir()) };
  const background = {
    name: 'background',
    async *run() {
      rmSync(`${file}.ack`, { force: true });
      for await (const chunk of provider('background', file).sendQuery('turn', tmpdir())) {
        yield chunk;
        if (chunk.type === 'result') writeFileSync(`${file}.ack`, 'result observed');
      }
    },
    runtimeStatus: (): 'running' | 'completed' =>
      readFileSync(file, 'utf8') === 'completed' ? 'completed' : 'running',
  };
  try {
    expect(
      await runProviderConformance({
        capabilities: descriptor.capabilities,
        turns: [turn],
        backgroundCases: [background],
        failureCases: [
          {
            name: 'auth',
            expected: 'auth',
            evidence: 'HTTP 401',
            run: () => provider().sendQuery('failure', tmpdir()),
          },
        ],
      })
    ).toEqual([]);
  } finally {
    await removeTempTree(directory);
  }
});

test.each(['host', 'container'] as const)('process uses the shared %s environment', async kind => {
  const options = {
    env: { PROCESS_CANARY: 'request-value' },
    execContext: kind === 'host' ? { kind } : { kind, containerId: 'test' },
  };
  const result = await collect(provider('env').sendQuery('turn', tmpdir(), undefined, options));
  expect(result[0].type).toBe('result');
  if (result[0].type !== 'result') throw new Error('missing result');
  const expected = buildProviderSubprocessEnv(options);
  const actual: unknown = JSON.parse(result[0].text ?? '{}');
  const expectedEntries = Object.entries(expected)
    .filter(([, value]) => value !== undefined)
    .sort();
  const actualEntries =
    typeof actual === 'object' && actual !== null ? Object.entries(actual).sort() : [];
  expect(JSON.stringify(actualEntries) === JSON.stringify(expectedEntries)).toBe(true);
});

test(
  'cancel kills the child tree even while the consumer is suspended',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'archon-provider-tree-'));
    const pidFile = join(directory, 'pids');
    const abort = new AbortController();
    const turn = provider('tree', pidFile).sendQuery('turn', tmpdir(), undefined, {
      abortSignal: abort.signal,
    });
    try {
      expect((await turn.next()).value).toEqual({ type: 'state_update', state: 'running' });
      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
      expect(pids.every(alive)).toBe(true);
      abort.abort();
      for (let i = 0; i < 540 && pids.some(alive); i++) await Bun.sleep(25);
      expect(pids.some(alive)).toBe(false);
      expect(existsSync(`${pidFile}.cancelled`)).toBe(true);
      expect(await collect(turn)).toEqual([]);
    } finally {
      await turn.return(undefined);
      await removeTempTree(directory);
    }
  },
  testTimeout(18_000)
);

test('early consumer return kills the tree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'archon-provider-return-'));
  try {
    const file = join(directory, 'pids');
    const turn = provider('tree', file).sendQuery('turn', tmpdir());
    await turn.next();
    const pids = JSON.parse(readFileSync(file, 'utf8')) as number[];
    await turn.return(undefined);
    for (let i = 0; i < 120 && pids.some(alive); i++) await Bun.sleep(25);
    expect(pids.some(alive)).toBe(false);
  } finally {
    await removeTempTree(directory);
  }
});

test('crash fails without settled and redacts split stderr in errors and logs', async () => {
  const secret = 'delivered-credential-value';
  const debug = spyOn(processLog, 'debug').mockImplementation(() => {});
  const output: ProviderChunk[] = [];
  try {
    let failure: unknown;
    try {
      for await (const chunk of provider('crash').sendQuery(
        'private message',
        tmpdir(),
        undefined,
        {
          env: { TEST_CREDENTIAL: secret, REQUEST_AUTH: 'sëcrét' },
          protectedEnvKeys: ['REQUEST_AUTH'],
        }
      ))
        output.push(chunk);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderPluginExitedError);
    if (!(failure instanceof ProviderPluginExitedError)) throw failure;
    expect(failure.exitCode).toBe(7);
    expect(failure.stderr).toContain('[REDACTED] crash evidence');
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain('private message');
    expect(failure.message).not.toContain('sëcrét');
    expect(output.map(chunk => chunk.type)).toEqual(['state_update']);
    expect(JSON.stringify(debug.mock.calls)).toContain('[REDACTED]');
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('sëcrét');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private message');
  } finally {
    debug.mockRestore();
  }
});

test('descriptor mismatch fails before starting a session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'archon-provider-descriptor-'));
  try {
    const file = join(directory, 'session');
    await expect(collect(provider('mismatch', file).sendQuery('turn', tmpdir()))).rejects.toThrow(
      'changed since install'
    );
    expect(existsSync(file)).toBe(false);
  } finally {
    await removeTempTree(directory);
  }
});

test('credential status and model resolution use fresh provider processes', async () => {
  const runtime = provider();
  expect(await runtime.resolveCredentialModel?.({ cwd: tmpdir() })).toBe('openai/native-model');
  expect(
    await runtime.checkCredential({
      env: { TEST_CREDENTIAL: 'present-value' },
      signal: AbortSignal.timeout(2000),
    })
  ).toEqual({ state: 'usable', source: 'native' });
  expect(
    await runtime.checkCredential({
      env: { TEST_CREDENTIAL: '' },
      signal: AbortSignal.timeout(2000),
    })
  ).toEqual({ state: 'not_connected', source: 'native' });
});

test(
  'credential check abort terminates the process',
  async () => {
    await expect(
      provider('hung-check').checkCredential({ env: {}, signal: AbortSignal.timeout(100) })
    ).rejects.toThrow();
  },
  testTimeout(18_000)
);

test('abort while a settled child is closing does not deliver settled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'archon-provider-closing-'));
  const file = join(directory, 'closing');
  const abort = new AbortController();
  const turn = provider('slow-exit', file).sendQuery('turn', tmpdir(), undefined, {
    abortSignal: abort.signal,
  });
  try {
    for (let i = 0; i < chunks.length - 1; i++)
      expect((await turn.next()).value).toEqual(chunks[i]);
    const terminal = turn.next();
    for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(5);
    expect(existsSync(file)).toBe(true);
    abort.abort();
    expect((await terminal).done).toBe(true);
  } finally {
    await turn.return(undefined);
    await removeTempTree(directory);
  }
});
