import pino from 'pino';
import type { Logger } from 'pino';
import pretty from 'pino-pretty';

export type { Logger } from 'pino';

/** Lazy-initialized logger (deferred so test mocks can intercept) */
let cachedLog: Logger | undefined;

function buildLogger(): Logger {
  const level = process.env.LOG_LEVEL?.toLowerCase() ?? 'info';
  const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';

  if (usePretty) {
    try {
      const stream = pretty({
        colorize: true,
        levelFirst: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      });
      return pino({ level }, stream);
    } catch {
      // Fall back to JSON output
    }
  }

  return pino({ level });
}

export function createLogger(module: string): Logger {
  if (!cachedLog) cachedLog = buildLogger();
  return cachedLog.child({ module });
}
