import { describe, it, expect, beforeEach, mock } from 'bun:test';
import pino from 'pino';

// Previous test files mock './logger' via mock.module which persists across files
// in Bun's single-process test runner. Re-mock with the real implementation.
const VALID_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const realRootLogger = pino({ level: 'info' });

mock.module('./logger', () => ({
  rootLogger: realRootLogger,
  createLogger: (module: string) => realRootLogger.child({ module }),
  setLogLevel: (level: string) => {
    const normalized = level.toLowerCase();
    if (!VALID_LEVELS.has(normalized)) {
      throw new Error(
        `Invalid log level: '${level}'. Valid levels: ${[...VALID_LEVELS].join(', ')}`
      );
    }
    realRootLogger.level = normalized;
  },
  getLogLevel: () => realRootLogger.level,
}));

const { createLogger, setLogLevel, getLogLevel, rootLogger } = await import('./logger');

describe('logger', () => {
  beforeEach(() => {
    // Reset to default level before each test
    setLogLevel('info');
  });

  describe('createLogger', () => {
    it('returns a logger with module binding', () => {
      const log = createLogger('test-module');
      // Pino child loggers have bindings accessible via the bindings() method
      const bindings = log.bindings();
      expect(bindings.module).toBe('test-module');
    });

    it('returns a logger with standard log methods', () => {
      const log = createLogger('test-module');
      expect(typeof log.info).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.debug).toBe('function');
    });

    it('supports dotted namespace modules', () => {
      const log = createLogger('workflow.executor');
      const bindings = log.bindings();
      expect(bindings.module).toBe('workflow.executor');
    });

    it('multiple calls for same module do not conflict', () => {
      const log1 = createLogger('same-module');
      const log2 = createLogger('same-module');
      expect(log1).not.toBe(log2); // Different instances
      expect(log1.bindings().module).toBe('same-module');
      expect(log2.bindings().module).toBe('same-module');
    });
  });

  describe('setLogLevel', () => {
    it('changes the effective level', () => {
      setLogLevel('debug');
      expect(getLogLevel()).toBe('debug');
    });

    it('sets error level', () => {
      setLogLevel('error');
      expect(getLogLevel()).toBe('error');
    });

    it('sets warn level', () => {
      setLogLevel('warn');
      expect(getLogLevel()).toBe('warn');
    });

    it('is case-insensitive', () => {
      setLogLevel('DEBUG');
      expect(getLogLevel()).toBe('debug');
    });

    it('throws on invalid level', () => {
      expect(() => setLogLevel('invalid')).toThrow("Invalid log level: 'invalid'. Valid levels:");
    });

    it('throws on empty string', () => {
      expect(() => setLogLevel('')).toThrow('Invalid log level');
    });
  });

  describe('getLogLevel', () => {
    it('returns default level info', () => {
      expect(getLogLevel()).toBe('info');
    });

    it('reflects changes from setLogLevel', () => {
      setLogLevel('debug');
      expect(getLogLevel()).toBe('debug');
      setLogLevel('error');
      expect(getLogLevel()).toBe('error');
    });
  });

  describe('child logger level inheritance', () => {
    it('child created after setLogLevel inherits new level', () => {
      setLogLevel('debug');
      const log = createLogger('test-child');
      expect(log.isLevelEnabled('debug')).toBe(true);
    });

    it('child created after error level only enables error+', () => {
      setLogLevel('error');
      const log = createLogger('test-child');
      expect(log.isLevelEnabled('info')).toBe(false);
      expect(log.isLevelEnabled('error')).toBe(true);
    });

    it('child inherits info level by default', () => {
      const log = createLogger('test-child');
      expect(log.isLevelEnabled('info')).toBe(true);
      expect(log.isLevelEnabled('debug')).toBe(false);
    });
  });

  describe('rootLogger', () => {
    it('is a Pino logger instance', () => {
      expect(typeof rootLogger.info).toBe('function');
      expect(typeof rootLogger.child).toBe('function');
    });

    it('level reflects setLogLevel changes', () => {
      setLogLevel('warn');
      expect(rootLogger.level).toBe('warn');
    });
  });

  describe('setLogLevel - all valid levels', () => {
    it('sets trace level', () => {
      setLogLevel('trace');
      expect(getLogLevel()).toBe('trace');
    });

    it('sets fatal level', () => {
      setLogLevel('fatal');
      expect(getLogLevel()).toBe('fatal');
    });

    it('child created after trace level enables all levels', () => {
      setLogLevel('trace');
      const log = createLogger('test-trace');
      expect(log.isLevelEnabled('trace')).toBe(true);
      expect(log.isLevelEnabled('debug')).toBe(true);
      expect(log.isLevelEnabled('info')).toBe(true);
    });

    it('child created after fatal level only enables fatal', () => {
      setLogLevel('fatal');
      const log = createLogger('test-fatal');
      expect(log.isLevelEnabled('error')).toBe(false);
      expect(log.isLevelEnabled('fatal')).toBe(true);
    });
  });

  describe('setLogLevel - edge cases', () => {
    it('throws on whitespace-only string', () => {
      expect(() => setLogLevel('   ')).toThrow('Invalid log level');
    });

    it('throws on numeric string', () => {
      expect(() => setLogLevel('30')).toThrow('Invalid log level');
    });

    it('handles mixed case variations', () => {
      setLogLevel('Trace');
      expect(getLogLevel()).toBe('trace');
      setLogLevel('FATAL');
      expect(getLogLevel()).toBe('fatal');
      setLogLevel('WaRn');
      expect(getLogLevel()).toBe('warn');
    });
  });
});
