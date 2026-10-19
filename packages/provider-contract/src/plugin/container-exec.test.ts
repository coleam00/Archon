import { expect, test } from 'bun:test';
import {
  coordinateContainerCommand,
  registerContainerExecGate,
  type ContainerExecGate,
} from '../container-exec';
import { connectProvider } from './connect';
import { installContainerExecHost } from './container-exec';
import { descriptor, fixtureProvider } from './fixtures/provider';
import { streamPair } from './fixtures/streams';
import { PluginRpc } from './rpc';
import { serveProvider } from './serve';
import { containerExecLeaseSchema } from './wire';
import { rpcMessageSchema } from './rpc';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  let failure: Error | undefined;
  const gate: ContainerExecGate = {
    run(operation) {
      const result = tail
        .catch(() => undefined)
        .then(() => {
          if (failure) throw failure;
          return operation();
        });
      tail = result;
      return result;
    },
    failAdmission(error) {
      failure = error;
    },
  };
  return gate;
}

test('a provider session acquires the host gate over RPC and releases before completion', async () => {
  const gate = queue();
  const unregister = registerContainerExecGate('rpc-container', gate);
  const entered = deferred();
  const release = deferred();
  const methods: string[] = [];
  const pair = streamPair((side, bytes) => {
    if (side !== 'provider') return;
    const message = rpcMessageSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if ('method' in message) methods.push(message.method);
  });
  const serving = serveProvider(
    {
      descriptor,
      create: () =>
        fixtureProvider({
          async *sendQuery(_prompt, _cwd, _resume, options) {
            if (options?.execContext?.kind !== 'container') throw new Error('Missing container');
            void coordinateContainerCommand(options.execContext.containerId, async () => {
              entered.resolve();
              await release.promise;
            });
            yield { type: 'settled' };
          },
        }),
    },
    pair.provider
  );
  const client = await connectProvider(pair.host);
  try {
    const stream = client.sendQuery('turn', '/work', undefined, {
      execContext: { kind: 'container', containerId: 'rpc-container' },
    });
    let completed = false;
    const pending = stream.next().then(value => {
      completed = true;
      return value;
    });
    await entered.promise;
    let transferred = false;
    const transfer = gate.run(async () => {
      transferred = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(transferred).toBe(false);
    release.resolve();
    expect((await pending).value).toEqual({ type: 'settled' });
    await stream.return(undefined);
    await transfer;
    expect(methods).toContain('_archon/container_exec/acquire');
    expect(methods).toContain('_archon/container_exec/release');
    expect(transferred).toBe(true);
  } finally {
    release.resolve();
    unregister();
    await client.close();
    await serving;
  }
});

test.each(['disconnect', 'failed-admission'] as const)(
  '%s refuses transfers after an unfinished remote admission',
  async mode => {
    const pair = streamPair();
    const host = new PluginRpc(pair.host);
    const remote = new PluginRpc(pair.provider);
    const gate = queue();
    const bridge = installContainerExecHost(host);
    bridge.enable('session', gate);
    try {
      const lease = containerExecLeaseSchema.parse(
        await remote.request('_archon/container_exec/acquire', { sessionId: 'session' })
      );
      if (mode === 'disconnect') {
        await remote.close();
        await host.done;
      } else {
        await remote.request('_archon/container_exec/release', {
          sessionId: 'session',
          ...lease,
          failedAdmission: true,
        });
      }
      await expect(gate.run(async () => {})).rejects.toThrow('inspect before explicit recovery');
    } finally {
      await remote.close();
      await host.close();
    }
  }
);

test('remote leases are scoped to the authorized session and connection', async () => {
  const pair = streamPair();
  const host = new PluginRpc(pair.host);
  const remote = new PluginRpc(pair.provider);
  const gate = queue();
  const bridge = installContainerExecHost(host);
  bridge.enable('session', gate);
  try {
    await expect(
      remote.request('_archon/container_exec/acquire', { sessionId: 'other' })
    ).rejects.toThrow('inactive or uncoordinated');
    const lease = containerExecLeaseSchema.parse(
      await remote.request('_archon/container_exec/acquire', { sessionId: 'session' })
    );
    await expect(
      remote.request('_archon/container_exec/release', {
        sessionId: 'other',
        ...lease,
        failedAdmission: false,
      })
    ).rejects.toThrow('unknown lease');
    await remote.request('_archon/container_exec/release', {
      sessionId: 'session',
      ...lease,
      failedAdmission: false,
    });
    await gate.run(async () => {});
    await expect(
      remote.request('_archon/container_exec/release', {
        sessionId: 'session',
        ...lease,
        failedAdmission: false,
      })
    ).rejects.toThrow('unknown lease');
  } finally {
    await remote.close();
    await host.close();
  }
});
