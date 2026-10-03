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

import { beginPiExtensionTurn } from '@archon/providers/community/pi';

import {
  exitAfterTelemetryFlush,
  handleUncaughtException,
  handleUnhandledRejection,
} from './index';

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

  test('stack-attested Pi extension rejections and exceptions fail the turn without exiting', async () => {
    order.length = 0;
    const exitSpy = spyOn(process, 'exit').mockImplementation(
      (() => undefined as never) as typeof process.exit
    );
    const extensionPath = '/extensions/fake-extension.ts';
    const turn = await beginPiExtensionTurn([extensionPath]);
    const received: Error[] = [];
    turn.onError(error => received.push(error));
    const rejection = new Error('extension rejection');
    rejection.stack = `Error: extension rejection\n    at callback (${extensionPath}:4:2)`;
    const cleanupNamedRejection = new Error('Operation aborted');
    cleanupNamedRejection.stack = `Error: Operation aborted\n    at callback (${extensionPath}:8:2)`;
    const exception = new Error('extension exception');
    exception.stack = `Error: extension exception\n    at callback (${extensionPath}:12:2)`;
    try {
      handleUnhandledRejection(cleanupNamedRejection);
      handleUnhandledRejection(rejection);
      handleUncaughtException(exception, 'uncaughtException');
      await Promise.resolve();

      expect(received).toEqual([cleanupNamedRejection]);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    } finally {
      turn.close();
      exitSpy.mockRestore();
    }
  });

  test('an exception outside an active Pi extension turn exits non-zero', async () => {
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
