import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

let stopped = Promise.withResolvers<void>();
const kill = mock(() => {
  stopped.resolve();
  return true;
});
type ServerProcess = EventEmitter & { stdout: PassThrough; stderr: PassThrough };
let spawned = Promise.withResolvers<ServerProcess>();
const launch = mock(() => {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
    exitCode: null,
    signalCode: null,
  });
  spawned.resolve(proc);
  return proc;
});
mock.module('cross-spawn', () => ({ default: launch }));

// Exercise the installed SDK's process-lifetime abort listener, replacing only process launch.
const { acquireEmbeddedRuntime, releaseEmbeddedRuntime, resetEmbeddedRuntime } = await import(
  './runtime'
);

describe('shared OpenCode runtime cancellation', () => {
  beforeEach(() => {
    spawned = Promise.withResolvers<ServerProcess>();
    stopped = Promise.withResolvers<void>();
    kill.mockClear();
    launch.mockClear();
    resetEmbeddedRuntime();
  });

  afterEach(() => resetEmbeddedRuntime());

  function ready(proc: ServerProcess): void {
    proc.stdout?.emit('data', Buffer.from('opencode server listening on http://localhost\n'));
  }

  for (const cancelledHolder of [0, 1]) {
    it(`keeps the server alive when holder ${cancelledHolder} aborts after startup`, async () => {
      const controllers = [new AbortController(), new AbortController()];
      const first = acquireEmbeddedRuntime(controllers[0].signal);
      ready(await spawned.promise);
      const holders = [await first, await acquireEmbeddedRuntime(controllers[1].signal)];
      expect(holders[0]).toBe(holders[1]);
      controllers[cancelledHolder].abort();
      expect(kill).not.toHaveBeenCalled();
      releaseEmbeddedRuntime(holders[cancelledHolder]);
      expect(kill).not.toHaveBeenCalled();
      expect(holders[1 - cancelledHolder].refCount).toBe(1);
      releaseEmbeddedRuntime(holders[1 - cancelledHolder]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it(`cancels waiter ${cancelledHolder} during startup without cancelling the other waiter`, async () => {
      const controllers = [new AbortController(), new AbortController()];
      const waiters = controllers.map(controller => acquireEmbeddedRuntime(controller.signal));
      const proc = await spawned.promise;
      controllers[cancelledHolder].abort();
      await expect(waiters[cancelledHolder]).rejects.toThrow('startup aborted');
      expect(kill).not.toHaveBeenCalled();
      ready(proc);
      const survivor = await waiters[1 - cancelledHolder];
      expect(survivor.refCount).toBe(1);
      expect(kill).not.toHaveBeenCalled();
      releaseEmbeddedRuntime(survivor);
      expect(kill).toHaveBeenCalledTimes(1);
    });
  }

  it('closes the server once startup finishes if its only waiter cancelled', async () => {
    const controller = new AbortController();
    const waiting = acquireEmbeddedRuntime(controller.signal);
    const proc = await spawned.promise;
    controller.abort();
    await expect(waiting).rejects.toThrow('startup aborted');
    ready(proc);
    await stopped.promise;
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('preserves startup failures for a live waiter after another cancels', async () => {
    const controller = new AbortController();
    const cancelled = acquireEmbeddedRuntime(controller.signal);
    const surviving = acquireEmbeddedRuntime();
    const proc = await spawned.promise;
    controller.abort();
    await expect(cancelled).rejects.toThrow('startup aborted');
    proc.emit('error', new Error('executable unavailable'));
    await expect(surviving).rejects.toThrow('executable unavailable');
    expect(kill).not.toHaveBeenCalled();

    spawned = Promise.withResolvers<ServerProcess>();
    const retry = acquireEmbeddedRuntime();
    ready(await spawned.promise);
    releaseEmbeddedRuntime(await retry);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('rejects already-aborted callers without starting a server', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireEmbeddedRuntime(controller.signal)).rejects.toThrow('startup aborted');
    expect(launch).not.toHaveBeenCalled();
  });
});
