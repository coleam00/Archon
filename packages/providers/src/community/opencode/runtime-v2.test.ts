import { afterAll, expect, mock, spyOn, test } from 'bun:test';

import { dirname, join } from 'node:path';

const endpoint = { url: 'http://127.0.0.1:4096' };
const healthGet = mock(async (): Promise<{ healthy: boolean }> => ({ healthy: true }));
const client = { health: { get: healthGet } };
const make = mock(() => client);

mock.module('@opencode-ai/client', () => ({ OpenCode: { make } }));

const binary = join(
  dirname(Bun.resolveSync('@opencode-ai/cli/package.json', import.meta.dir)),
  'bin',
  'opencode2.exe'
);
const whichSpy = spyOn(Bun, 'which').mockReturnValue(binary);
let serviceExited = Promise.withResolvers<number>();
const serviceKill = mock((): void => serviceExited.resolve(0));
const serviceStdinEnd = mock((): void => undefined);
const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(command => {
  const args = Array.isArray(command) ? command : command.cmd;
  if (args.includes('--version')) {
    return {
      exited: Promise.resolve(0),
      stdout: new Response('opencode2 v0.0.0-beta-17963').body!,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }
  return {
    exited: serviceExited.promise,
    stdout: new Response(`${JSON.stringify(endpoint)}\n`).body!,
    stderr: new Response('').body!,
    stdin: { end: serviceStdinEnd },
    kill: serviceKill,
  } as unknown as ReturnType<typeof Bun.spawn>;
});

const { acquireV2Runtime, OPENCODE_V2_VERSION } = await import('./runtime-v2');

function resetService(): void {
  serviceExited = Promise.withResolvers<number>();
  serviceKill.mockClear();
  serviceStdinEnd.mockClear();
  healthGet.mockReset();
  healthGet.mockImplementation(async (): Promise<{ healthy: boolean }> => ({ healthy: true }));
  make.mockClear();
  spawnSpy.mockClear();
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current instanceof Error && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  chain.push(current);
  return chain;
}

afterAll(() => {
  whichSpy.mockRestore();
  spawnSpy.mockRestore();
});

test('owns a matching OpenCode V2 sidecar and releases exactly that process', async () => {
  resetService();
  const runtime = await acquireV2Runtime();

  expect(spawnSpy).toHaveBeenNthCalledWith(
    1,
    [binary, '--version'],
    expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
  );
  expect(spawnSpy).toHaveBeenNthCalledWith(
    2,
    [binary, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
    expect.objectContaining({
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: expect.objectContaining({
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: expect.any(String),
      }),
    })
  );
  expect(make).toHaveBeenCalledWith({
    baseUrl: endpoint.url,
    headers: { authorization: expect.stringMatching(/^Basic /) },
  });
  expect(runtime.endpoint).toMatchObject({
    ...endpoint,
    auth: { type: 'basic', username: 'opencode', password: expect.any(String) },
  });
  expect(OPENCODE_V2_VERSION).toBe('0.0.0-beta-17963');

  await runtime.release();
  await runtime.release();
  expect(serviceStdinEnd).toHaveBeenCalledTimes(1);
  expect(serviceKill).toHaveBeenCalledTimes(1);
});

test('keeps the last health failure and cleans up a timed-out child', async () => {
  resetService();
  const healthError = new Error('pinned protocol mismatch');
  let fireStartupTimeout: (() => void) | undefined;
  healthGet.mockImplementation(async (): Promise<never> => {
    fireStartupTimeout?.();
    throw healthError;
  });
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number
  ): ReturnType<typeof setTimeout> => {
    if (timeout === 10_000) {
      fireStartupTimeout = (): void => handler();
      return realSetTimeout(() => undefined, 60_000) as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler, timeout) as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);

  try {
    let failure: unknown;
    try {
      await acquireV2Runtime();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(causeChain(failure)).toContain(healthError);
    expect(serviceStdinEnd).toHaveBeenCalledTimes(1);
    expect(serviceKill).toHaveBeenCalledTimes(1);
    await expect(serviceExited.promise).resolves.toBe(0);
  } finally {
    timeoutSpy.mockRestore();
  }
});
