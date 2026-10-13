import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '@archon/paths';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { buildProviderSubprocessEnv, type ProviderChunk } from '@archon/provider-contract';
import { runProviderConformance } from '@archon/provider-contract/conformance';
import { PluginRemoteError } from '@archon/provider-contract/plugin';
import { ProviderPluginExitedError } from './process-provider';
import { processProviderRegistration } from './process-registration';
import { descriptor, chunks } from './fixtures/process-provider-data';

const processLog = paths.createLogger('core.provider-process');
const providerLog = paths.createLogger(`provider.${descriptor.id}`);
const realCreateLogger = paths.createLogger;
spyOn(paths, 'createLogger').mockImplementation(module =>
  module === 'core.provider-process'
    ? processLog
    : module === `provider.${descriptor.id}`
      ? providerLog
      : realCreateLogger(module)
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

test.each(['host', 'container'] as const)(
  'provider receives the %s execution environment',
  async kind => {
    const options = {
      env: { PROCESS_CANARY: 'request-value' },
      execContext: kind === 'host' ? { kind } : { kind, containerId: 'test' },
    };
    process.env.PROCESS_HOST_CANARY = 'host-value';
    try {
      const result = await collect(provider('env').sendQuery('turn', tmpdir(), undefined, options));
      expect(result[0].type).toBe('result');
      if (result[0].type !== 'result') throw new Error('missing result');
      const expected = kind === 'container' ? options.env : buildProviderSubprocessEnv(options);
      const actual = JSON.parse(result[0].text ?? '{}') as Record<string, unknown>;
      const missing = Object.entries(expected).filter(
        ([key, value]) => value !== undefined && actual[key] !== value
      );
      expect(missing.map(([key]) => key)).toEqual([]);
      expect(actual.PROCESS_CANARY).toBe('request-value');
      expect('PROCESS_HOST_CANARY' in actual).toBe(kind === 'host');
    } finally {
      delete process.env.PROCESS_HOST_CANARY;
    }
  }
);

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
        'private message\nsecond private line',
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
    expect(failure.stderr).toContain('[REDACTED]');
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain('private message');
    expect(failure.message).not.toContain('sëcrét');
    expect(output.map(chunk => chunk.type)).toEqual(['state_update']);
    expect(JSON.stringify(debug.mock.calls)).toContain('stderrBytes');
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
    const pids = JSON.parse(readFileSync(`${file}.pids`, 'utf8')) as number[];
    expect(pids.every(alive)).toBe(true);
    abort.abort();
    expect((await terminal).done).toBe(true);
    for (let i = 0; i < 120 && pids.some(alive); i++) await Bun.sleep(25);
    expect(pids.some(alive)).toBe(false);
  } finally {
    await turn.return(undefined);
    await removeTempTree(directory);
  }
});

test.each(['turn', 'credential', 'model', 'diagnose', 'models'] as const)(
  'live transport EOF terminates the %s process',
  async operation => {
    const directory = mkdtempSync(join(tmpdir(), 'archon-provider-eof-'));
    const file = join(directory, 'pid');
    const runtime = provider('live-eof', file);
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      if (existsSync(file)) process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
    }, 13_000);
    try {
      const request =
        operation === 'turn'
          ? collect(runtime.sendQuery('turn', tmpdir()))
          : operation === 'credential'
            ? runtime.checkCredential({ env: {}, signal: new AbortController().signal })
            : operation === 'model'
              ? runtime.resolveCredentialModel?.({ cwd: tmpdir() })
              : operation === 'diagnose'
                ? runtime.diagnose?.({ signal: new AbortController().signal })
                : runtime.listModels?.({ signal: new AbortController().signal });
      await expect(request).rejects.toBeInstanceOf(ProviderPluginExitedError);
      expect(watchdogFired).toBe(false);
      expect(alive(Number(readFileSync(file, 'utf8')))).toBe(false);
    } finally {
      clearTimeout(watchdog);
      if (existsSync(file)) {
        const pid = Number(readFileSync(file, 'utf8'));
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
      await removeTempTree(directory);
    }
  },
  testTimeout(18_000)
);

test('a resume ID reaches the provider across the real process boundary', async () => {
  expect(await collect(provider('resume').sendQuery('turn', tmpdir(), 'previous-session'))).toEqual(
    [{ type: 'result', sessionId: 'previous-session' }, { type: 'settled' }]
  );
});

test('credential crash diagnostics withhold short custom credential values', async () => {
  const debug = spyOn(processLog, 'debug').mockImplementation(() => {});
  try {
    let failure: unknown;
    try {
      await provider('credential-crash').checkCredential({
        env: { CUSTOM_CREDENTIAL: '§' },
        signal: new AbortController().signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderPluginExitedError);
    if (!(failure instanceof ProviderPluginExitedError)) throw failure;
    expect(failure.exitCode).toBe(7);
    expect(failure.message).not.toContain('§');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('§');
  } finally {
    debug.mockRestore();
  }
});

test('container request env does not replace the plugin host environment', async () => {
  process.env.PROCESS_HOST_CANARY = 'host-value';
  try {
    const result = await collect(
      provider('plugin-env').sendQuery('turn', tmpdir(), undefined, {
        execContext: { kind: 'container', containerId: 'test' },
        env: { PROCESS_CANARY: 'container-value', PATH: 'container-path' },
      })
    );
    expect(result[0].type).toBe('result');
    if (result[0].type !== 'result') throw new Error('missing result');
    expect(JSON.parse(result[0].text ?? '{}')).toEqual({
      host: 'host-value',
      path: process.env.PATH,
    });
  } finally {
    delete process.env.PROCESS_HOST_CANARY;
  }
});

test('provider logs preserve severity and withhold arbitrary content', async () => {
  const info = spyOn(providerLog, 'info').mockImplementation(() => {});
  const warn = spyOn(providerLog, 'warn').mockImplementation(() => {});
  const previous = process.env.CONTAINER_TOKEN;
  process.env.CONTAINER_TOKEN = 'host-credential';
  try {
    await collect(
      provider('logs').sendQuery(
        'private message container-credential\nsecond private line',
        tmpdir(),
        undefined,
        {
          execContext: { kind: 'container', containerId: 'test' },
          env: {
            CONTAINER_TOKEN: 'container-credential',
            CUSTOM_AUTH: '§',
            NUMERIC_TOKEN: '12345678',
          },
          systemPrompt: 'private system guidance',
          protectedEnvKeys: ['CUSTOM_AUTH'],
        }
      )
    );
    expect(warn.mock.calls).toEqual([[{}, 'provider.plugin.log']]);
    expect(info.mock.calls).toEqual([]);
  } finally {
    info.mockRestore();
    warn.mockRestore();
    if (previous === undefined) delete process.env.CONTAINER_TOKEN;
    else process.env.CONTAINER_TOKEN = previous;
  }
});

test('information hooks round-trip through fresh processes and close them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'archon-provider-information-'));
  try {
    const file = join(directory, 'pid');
    const runtime = provider('record-pid', file);
    expect(
      await runtime.diagnose?.({
        signal: new AbortController().signal,
        assistantConfig: { model: 'fixture/model', omitted: undefined },
      })
    ).toEqual({
      checks: [
        {
          id: 'config',
          label: 'Configuration',
          status: 'ok',
          message: 'Configuration inspected',
          remedy: 'Select a model',
        },
      ],
    });
    const firstPid = Number(readFileSync(file, 'utf8'));
    expect(alive(firstPid)).toBe(false);
    expect(await runtime.listModels?.({ signal: new AbortController().signal })).toEqual({
      models: [{ id: 'fixture/model', label: 'Fixture model' }, { id: 'fixture/other' }],
    });
    const secondPid = Number(readFileSync(file, 'utf8'));
    expect(secondPid).not.toBe(firstPid);
    expect(alive(secondPid)).toBe(false);
  } finally {
    await removeTempTree(directory);
  }
});

test('diagnostic hook errors withhold plugin prose and stderr', async () => {
  const debug = spyOn(processLog, 'debug').mockImplementation(() => {});
  try {
    const error: unknown = await provider('information-crash')
      .diagnose?.({ signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PluginRemoteError);
    if (!(error instanceof PluginRemoteError)) throw error;
    expect(error.code).toBe(-32603);
    expect(error.message).toContain('request failed (RPC -32603)');
    expect(error.message).not.toContain('private message and token');
    expect(error.data).toBeUndefined();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private message and token');
  } finally {
    debug.mockRestore();
  }
});

test.each(['models', 'diagnose'] as const)(
  'a caller cancellation stops a stalled %s process by its recorded PID',
  async operation => {
    const directory = mkdtempSync(join(tmpdir(), 'archon-models-cancel-'));
    const file = join(directory, 'pid');
    const abort = new AbortController();
    const runtime = provider(operation === 'models' ? 'hung-models' : 'hung-diagnose', file);
    try {
      const pending =
        operation === 'models'
          ? runtime.listModels?.({ signal: abort.signal })
          : runtime.diagnose?.({ signal: abort.signal });
      for (let attempt = 0; attempt < 200 && !existsSync(file); attempt++) await Bun.sleep(10);
      expect(existsSync(file)).toBe(true);
      abort.abort(new Error('model list cancelled'));
      await expect(pending).rejects.toThrow();
      expect(alive(Number(readFileSync(file, 'utf8')))).toBe(false);
    } finally {
      abort.abort();
      await removeTempTree(directory);
    }
  },
  testTimeout(18_000)
);

test('Claude resume and fork retain per-query cost and model across fresh processes and factory lookups', async () => {
  const { descriptor: claude } = await import('@archon/providers/claude/descriptor');
  const registration = processProviderRegistration(claude, [
    process.execPath,
    join(import.meta.dir, '../../../providers/src/claude/fixtures/process-spend.ts'),
  ]);
  async function resultOf(resume?: string, forkSession = false) {
    const output = await collect(
      registration.factory().sendQuery('turn', tmpdir(), resume, {
        forkSession,
        assistantConfig: { claudeBinaryPath: process.execPath },
      })
    );
    const result = output.find(chunk => chunk.type === 'result');
    if (!result || result.type !== 'result') throw new Error('missing Claude result');
    expect(result.isError).not.toBe(true);
    return result;
  }
  const fresh = await resultOf();
  expect(fresh.cost).toBe(0.13);
  const fork = await resultOf(fresh.sessionId, true);
  expect(fork.sessionId).toBe('source-fork');
  expect(fork.cost).toBeCloseTo(0.22, 10);
  expect(fork.resolvedModel).toEqual({ id: 'claude-sonnet-4-6' });
  const resumed = await resultOf(fresh.sessionId);
  expect(resumed.cost).toBeCloseTo(0.22, 10);
  expect(resumed.resolvedModel).toEqual({ id: 'claude-sonnet-4-6' });
  expect(new Set([fresh.text, fork.text, resumed.text]).size).toBe(3);
  const child = await resultOf(fork.sessionId);
  expect(child.cost).toBe(0);
  expect(child.resolvedModel).toBeUndefined();
  const unseen = await resultOf('unseen');
  expect(unseen.cost).toBeUndefined();
  expect(unseen.resolvedModel).toBeUndefined();
});

test('plugins that return no state never receive the new request field', async () => {
  const registration = processProviderRegistration(descriptor, [
    process.execPath,
    fixture,
    'legacy-resume',
  ]);
  for (let turn = 0; turn < 2; turn++) {
    expect(await collect(registration.factory().sendQuery('turn', tmpdir(), 'legacy'))).toEqual([
      { type: 'result', sessionId: 'legacy' },
      { type: 'settled' },
    ]);
  }
});
