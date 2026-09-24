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

import { exitAfterTelemetryFlush } from './index';

describe('exitAfterTelemetryFlush', () => {
  test('flushes telemetry before exiting with the given code', async () => {
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
