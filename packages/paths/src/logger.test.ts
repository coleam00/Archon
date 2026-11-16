import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createLogger, setLogLevel, getLogLevel } from './logger';

const originalLevel = getLogLevel();

describe('logger', () => {
  afterEach(() => {
    setLogLevel(originalLevel);
  });

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

    it('supports dotted namespace modules', () => {
      const log = createLogger('workflow.executor');
      const bindings = log.bindings();
      expect(bindings.module).toBe('workflow.executor');
    });
  });

  describe('setLogLevel', () => {
    it('changes the effective level', () => {
      setLogLevel('debug');
      expect(getLogLevel()).toBe('debug');
    });

    it('throws on invalid level', () => {
      expect(() => setLogLevel('invalid')).toThrow("Invalid log level: 'invalid'. Valid levels:");
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

  describe('child logger level inheritance', () => {
    it('child created after error level only enables error+', () => {
      setLogLevel('error');
      const log = createLogger('test-child');
      expect(log.isLevelEnabled('info')).toBe(false);
      expect(log.isLevelEnabled('error')).toBe(true);
    });
  });
});
