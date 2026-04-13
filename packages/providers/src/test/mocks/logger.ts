import { mock } from 'bun:test';
import type { Logger } from 'pino';

export interface MockLogger extends Logger {
  fatal: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  trace: ReturnType<typeof mock>;
  child: ReturnType<typeof mock>;
}

export function createMockLogger(): MockLogger {
  const logger = {
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(() => logger),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  } as unknown as MockLogger;
  return logger;
}
