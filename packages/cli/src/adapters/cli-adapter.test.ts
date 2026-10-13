/**
 * Tests for CLIAdapter
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

const recordMessage = mock(
  async (
    _id: string,
    _message: string,
    _metadata?: Parameters<CLIAdapter['sendMessage']>[2]
  ): Promise<void> => {}
);

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { CLIAdapter } from './cli-adapter';

describe('CLIAdapter', () => {
  let adapter: CLIAdapter;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    adapter = new CLIAdapter();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    recordMessage.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should default to batch mode', () => {
      const defaultAdapter = new CLIAdapter();
      expect(defaultAdapter.getStreamingMode()).toBe('batch');
    });

    it('should accept stream mode option', () => {
      const streamAdapter = new CLIAdapter({ streamingMode: 'stream' });
      expect(streamAdapter.getStreamingMode()).toBe('stream');
    });

    it('should accept batch mode option', () => {
      const batchAdapter = new CLIAdapter({ streamingMode: 'batch' });
      expect(batchAdapter.getStreamingMode()).toBe('batch');
    });
  });

  describe('sendMessage', () => {
    it('should output message to console.log', async () => {
      await adapter.sendMessage('test-123', 'Hello, world!');
      expect(consoleSpy).toHaveBeenCalledWith('Hello, world!');
    });

    it('should handle empty messages', async () => {
      await adapter.sendMessage('test-123', '');
      expect(consoleSpy).toHaveBeenCalledWith('');
    });

    it('should handle multi-line messages', async () => {
      const multiLine = 'Line 1\nLine 2\nLine 3';
      await adapter.sendMessage('test-123', multiLine);
      expect(consoleSpy).toHaveBeenCalledWith(multiLine);
    });

    it('prints without a message recorder', async () => {
      await adapter.sendMessage('unregistered-id', 'test');
      await adapter.sendMessage('another-unregistered-id', 'test');
      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(recordMessage).not.toHaveBeenCalled();
    });
  });

  describe('message recorder', () => {
    it('passes the correlation, message and metadata to the supplied recorder', async () => {
      adapter = new CLIAdapter({ recordMessage });
      const metadata = { category: 'workflow_status' as const, segment: 'new' as const };
      await adapter.sendMessage('run-id', 'Hello', metadata);
      expect(recordMessage).toHaveBeenCalledWith('run-id', 'Hello', metadata);
      expect(consoleSpy).toHaveBeenCalledWith('Hello');
    });

    it('reports recording failures while preserving stdout delivery', async () => {
      recordMessage.mockRejectedValueOnce(new Error('Recorder unavailable'));
      adapter = new CLIAdapter({ recordMessage });
      await expect(adapter.sendMessage('run-id', 'Hello')).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith('Hello');
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('ensureThread', () => {
    it('should return the same conversation ID (passthrough)', async () => {
      const result = await adapter.ensureThread('original-123');
      expect(result).toBe('original-123');
    });

    it('should ignore message context', async () => {
      const result = await adapter.ensureThread('id', { some: 'context' });
      expect(result).toBe('id');
    });
  });

  describe('getStreamingMode', () => {
    it('should return the configured streaming mode', () => {
      expect(adapter.getStreamingMode()).toBe('batch');
    });
  });

  describe('getPlatformType', () => {
    it('should return "cli"', () => {
      expect(adapter.getPlatformType()).toBe('cli');
    });
  });

  describe('formatWorkflowCommand', () => {
    it('spells workflow commands as archon CLI subcommands', () => {
      expect(adapter.formatWorkflowCommand('abandon abc12345')).toBe(
        'archon workflow abandon abc12345'
      );
    });
  });

  describe('start', () => {
    it('should be a no-op (returns void)', async () => {
      const result = await adapter.start();
      expect(result).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('should be a no-op (returns void)', () => {
      const result = adapter.stop();
      expect(result).toBeUndefined();
    });
  });
});
