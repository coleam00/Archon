import { describe, expect, mock, spyOn, test } from 'bun:test';

const order: string[] = [];
const noop = (): undefined => undefined;
const logger = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child(): unknown {
    return logger;
  },
};
mock.module('@archon/paths', () => ({
  createLogger: () => logger,
  logArchonPaths: noop,
  validateAppDefaultsPaths: noop,
  shutdownTelemetry: mock(async () => {
    await Promise.resolve();
    order.push('flush');
  }),
}));

import { exitAfterTelemetryFlush, handleUnhandledRejection } from './index';

describe('exitAfterTelemetryFlush', () => {
  test('a fatal unhandled rejection flushes before exiting; an SDK cleanup race does not exit', async () => {
    order.length = 0;
    const exited = Promise.withResolvers<void>();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit ${code}`);
      exited.resolve();
      return undefined as never;
    }) as typeof process.exit);
    try {
      handleUnhandledRejection(new Error('Operation aborted'));
      handleUnhandledRejection(new Error('boom'));
      await exited.promise;
      expect(order).toEqual(['flush', 'exit 1']);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('flushes telemetry before exiting with the given code', async () => {
    order.length = 0;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit ${code}`);
      throw new Error('exited');
    }) as typeof process.exit);
    try {
      await expect(exitAfterTelemetryFlush(1)).rejects.toThrow('exited');
      expect(order).toEqual(['flush', 'exit 1']);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
