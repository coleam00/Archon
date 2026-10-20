import { expect, test } from 'bun:test';
import { requireMcpConnections, type McpStatus } from './readiness';

const status = (state: McpStatus['status'], error?: string): McpStatus => ({
  type: 'mcp_server_status',
  server: 'declared',
  status: state,
  ...(error ? { error } : {}),
});
async function collect(stream: AsyncGenerator<McpStatus>): Promise<McpStatus[]> {
  return Array.fromAsync(stream);
}

test('requires only declared servers and accepts an empty declaration', async () => {
  expect(
    await collect(
      requireMcpConnections(['declared'], async () => [
        status('connected'),
        {
          ...status('failed'),
          server: 'other',
        },
      ])
    )
  ).toEqual([status('connected')]);
  expect(
    await collect(
      requireMcpConnections([], async () => {
        throw new Error('unused');
      })
    )
  ).toEqual([]);
});

for (const state of ['failed', 'needs_auth', 'disabled'] as const) {
  test(`reports ${state} with server and cause before rejecting admission`, async () => {
    const stream = requireMcpConnections(['declared'], async () => [status(state, 'vendor cause')]);
    expect((await stream.next()).value).toEqual(status(state, 'vendor cause'));
    await expect(stream.next()).rejects.toMatchObject({
      failureClass: 'misconfigured',
      message: expect.stringContaining('declared'),
    });
    const retry = requireMcpConnections(['declared'], async () => [status(state, 'vendor cause')]);
    await expect(collect(retry)).rejects.toThrow('vendor cause');
  });
}

test('waits for connection and emits only changed observations', async () => {
  let reads = 0;
  const stream = requireMcpConnections(['declared'], async () => [
    status(++reads < 3 ? 'pending' : 'connected'),
  ]);
  expect(await collect(stream)).toEqual([status('pending'), status('connected')]);
  expect(reads).toBe(3);
});

test('missing inventory and transport rejection cannot release input', async () => {
  await expect(collect(requireMcpConnections(['declared'], async () => []))).rejects.toThrow(
    'declared'
  );
  const error = new Error('transport lost');
  await expect(
    collect(
      requireMcpConnections(['declared'], async () => {
        throw error;
      })
    )
  ).rejects.toBe(error);
});

test('abort stops pending readiness without more observations', async () => {
  const controller = new AbortController();
  const stream = requireMcpConnections(
    ['declared'],
    async () => [status('pending')],
    controller.signal
  );
  await stream.next();
  controller.abort();
  await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
});

test('abort interrupts a blocked native status read', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const stream = requireMcpConnections(
    ['declared'],
    async () => {
      entered.resolve();
      return new Promise<McpStatus[]>(() => {});
    },
    controller.signal
  );
  const next = stream.next();
  await entered.promise;
  controller.abort();
  await expect(next).rejects.toMatchObject({ name: 'AbortError' });
});

test('every declared server must connect before admission', async () => {
  const controller = new AbortController();
  const stream = requireMcpConnections(
    ['declared', 'second'],
    async () => [status('connected'), { ...status('pending'), server: 'second' }],
    controller.signal
  );
  expect((await stream.next()).value).toEqual(status('connected'));
  expect((await stream.next()).value).toEqual({ ...status('pending'), server: 'second' });
  const admission = stream.next();
  // Abort on the next task, after the generator has evaluated both observations.
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await expect(admission).rejects.toMatchObject({ name: 'AbortError' });
});
