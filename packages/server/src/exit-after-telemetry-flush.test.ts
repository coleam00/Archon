import { beginPiExtensionTurn } from '@archon/providers/pi/extension-error-broker';
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
  BUNDLED_IS_BINARY: true,
  createLogger: () => logger,
  logArchonPaths: noop,
  validateAppDefaultsPaths: noop,
  shutdownTelemetry: mock(async () => {
    await Promise.resolve();
    order.push('flush');
  }),
}));

import {
  exitAfterTelemetryFlush,
  handleUncaughtException,
  handleUnhandledRejection,
} from './index';

describe('exitAfterTelemetryFlush', () => {
  test.each(['Operation aborted', 'boom'])(
    'an unhandled rejection flushes before exiting regardless of message: %s',
    async message => {
      order.length = 0;
      const exited = Promise.withResolvers<void>();
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
        order.push(`exit ${code}`);
        exited.resolve();
        return undefined as never;
      }) as typeof process.exit);
      try {
        handleUnhandledRejection(new Error(message));
        await exited.promise;
        expect(order).toEqual(['flush', 'exit 1']);
      } finally {
        exitSpy.mockRestore();
      }
    }
  );

  test('a fatal exception flushes telemetry and exits non-zero', async () => {
    order.length = 0;
    const exited = Promise.withResolvers<void>();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit ${code}`);
      exited.resolve();
      return undefined as never;
    }) as typeof process.exit);
    try {
      handleUncaughtException(new Error('engine bug'), 'uncaughtException');
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

test.each(['unhandledRejection', 'uncaughtException'] as const)(
  'retained Pi routes %s to its extension turn before fatal fallback',
  event => {
    const turn = beginPiExtensionTurn(['/extensions/review.ts']);
    const error = new Error('extension callback failed');
    error.stack = 'Error: extension callback failed\n    at callback (/extensions/review.ts:12:3)';
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('host exited');
    });
    order.length = 0;
    try {
      if (event === 'unhandledRejection') handleUnhandledRejection(error);
      else handleUncaughtException(error, 'uncaughtException');
      expect(() => turn.throwIfFailed()).toThrow(error);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    } finally {
      turn.close();
      exitSpy.mockRestore();
    }
  }
);
