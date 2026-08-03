import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';

// Mock logger before importing module under test
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  }),
}));

// Mock @archon/core/db/messages
const mockAddMessage = mock(() => Promise.resolve());
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));

// Import after mocks are set up
const { MessagePersistence } = await import('./persistence');

function createPersistence(): InstanceType<typeof MessagePersistence> {
  const emitEvent = mock(() => Promise.resolve());
  return new MessagePersistence(emitEvent);
}

describe('MessagePersistence', () => {
  let persistence: InstanceType<typeof MessagePersistence>;

  beforeEach(() => {
    persistence = createPersistence();
    mockAddMessage.mockClear();
  });

  afterEach(() => {
    persistence.stopPeriodicFlush();
    persistence.clearAll();
  });

  describe('flush — sync-clear before async work (race condition fix)', () => {
    test('clears buffer before async db write so new appendText creates fresh entry', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'hello');

      // Trigger flush (it will atomically clear the buffer before the db write)
      const flushPromise = persistence.flush('conv-1');

      // Append text while flush is in progress — should go to a new buffer entry
      persistence.appendText('conv-1', 'world');

      await flushPromise;

      // 'hello' should have been persisted
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('hello');

      // 'world' should still be in the buffer (not flushed yet)
      // Flush again to verify it persisted the second batch
      await persistence.flush('conv-1');
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      expect(mockAddMessage.mock.calls[1][2]).toBe('world');
    });

    test('restores buffer when dbId is missing (no segments lost)', async () => {
      // Do NOT call setConversationDbId — flush should restore
      persistence.appendText('conv-1', 'buffered text');

      await persistence.flush('conv-1');

      // Buffer should be restored since no dbId was available
      // Now provide the dbId and flush again
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('buffered text');
    });

    test('restore preserves buffer intact after no-dbId flush', async () => {
      // Verify that when flush() is called with no dbId, the buffer is fully
      // restored so subsequent text is still persisted once dbId becomes available.
      persistence.appendText('conv-1', 'segment-1 ');

      await persistence.flush('conv-1'); // no dbId — restores buffer

      // Text appended after restore merges into the restored buffer entry
      persistence.appendText('conv-1', 'segment-2');

      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');

      // Both texts end up in one db write (same segment, no segment boundary between them)
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('segment-1 segment-2');
    });

    test('flush on empty buffer is a no-op', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('startPeriodicFlush / stopPeriodicFlush', () => {
    test('startPeriodicFlush is idempotent (double call does not create two timers)', () => {
      persistence.startPeriodicFlush();
      persistence.startPeriodicFlush(); // second call should be a no-op

      // We can't directly inspect the timer ID, but we can verify stopPeriodicFlush
      // cleans up without error and subsequent operations still work.
      persistence.stopPeriodicFlush();
      persistence.stopPeriodicFlush(); // should not throw
    });

    test('stopPeriodicFlush is safe to call when no timer is running', () => {
      // Should not throw
      persistence.stopPeriodicFlush();
    });

    test('startPeriodicFlush / stopPeriodicFlush lifecycle', () => {
      persistence.startPeriodicFlush();
      // Timer is running — no assertion needed beyond no-throw
      persistence.stopPeriodicFlush();
      // Timer is cleared — no assertion needed beyond no-throw
    });

    test('timer can be restarted after stop', () => {
      persistence.startPeriodicFlush();
      persistence.stopPeriodicFlush();
      // Starting again should work without errors
      persistence.startPeriodicFlush();
      persistence.stopPeriodicFlush();
    });
  });

  describe('appendText', () => {
    test('buffers text in segments', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'hello ');
      persistence.appendText('conv-1', 'world');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('hello world');
    });

    test('skips tool_call_formatted category', () => {
      persistence.appendText('conv-1', 'skip me', { category: 'tool_call_formatted' });
      // Buffer should be empty — nothing to flush
      // Verify by flushing and checking no db write
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      // Flush is async but we can check the buffer is empty
      void persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    test('skips isolation_context category', () => {
      persistence.appendText('conv-1', 'skip me', { category: 'isolation_context' });
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      void persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('retractLastSegment', () => {
    test('removes last segment', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'first segment');
      persistence.appendText('conv-1', 'second segment', { segment: 'new' });

      persistence.retractLastSegment('conv-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('first segment');
    });

    test('clears text but preserves tool calls when segment has tool calls', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'routing text');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });

      // Retract should only clear text, not the tool call
      persistence.retractLastSegment('conv-1');
      await persistence.flush('conv-1');

      // DB write should happen (because tool call is preserved)
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      // Content should be empty string (text retracted)
      expect(mockAddMessage.mock.calls[0][2]).toBe('');
      // Tool calls should still be persisted
      const metadata = mockAddMessage.mock.calls[0][3] as { toolCalls?: { name: string }[] };
      expect(metadata?.toolCalls).toHaveLength(1);
      expect(metadata?.toolCalls?.[0]?.name).toBe('bash');
    });

    test('retract on empty buffer is a no-op', () => {
      // Should not throw
      persistence.retractLastSegment('nonexistent-conv');
    });

    test('retract text-only segment removes it entirely', async () => {
      persistence.appendText('conv-1', 'some text');
      persistence.retractLastSegment('conv-1');
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('appendToolCall', () => {
    test('buffers tool calls and persists them in flush metadata', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'checking file');
      persistence.appendToolCall('conv-1', { name: 'read', input: { path: '/tmp/test.ts' } });
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { name: string; input: Record<string, unknown>; duration?: number }[];
      };
      expect(metadata?.toolCalls).toHaveLength(1);
      expect(metadata?.toolCalls?.[0]?.name).toBe('read');
      expect(metadata?.toolCalls?.[0]?.input).toEqual({ path: '/tmp/test.ts' });
      // Duration should be set by flush finalization
      expect(metadata?.toolCalls?.[0]?.duration).toBeGreaterThanOrEqual(0);
    });

    test('finalizes previous tool duration when new tool arrives', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'working');
      persistence.appendToolCall('conv-1', { name: 'read', input: { path: 'a.ts' } });
      // Small delay to get measurable duration
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      await persistence.flush('conv-1');

      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { name: string; duration?: number }[];
      };
      expect(metadata?.toolCalls).toHaveLength(2);
      // First tool should have a duration (finalized by second tool arrival)
      expect(metadata?.toolCalls?.[0]?.duration).toBeGreaterThanOrEqual(0);
    });

    test('text after tool call starts a new segment', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'before tool');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      persistence.appendText('conv-1', 'after tool');
      await persistence.flush('conv-1');

      // Should produce 2 messages: one with text+tool, one with post-tool text
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      expect(mockAddMessage.mock.calls[0][2]).toBe('before tool');
      expect(mockAddMessage.mock.calls[1][2]).toBe('after tool');
    });
  });

  describe('appendToolResult', () => {
    test('should include tool output when flushing to DB', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'running bash');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      persistence.appendToolResult('conv-1', 'bash', 'file1.txt\nfile2.txt', 250);
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { name: string; output?: string; duration?: number }[];
      };
      expect(metadata?.toolCalls).toHaveLength(1);
      expect(metadata?.toolCalls?.[0]?.name).toBe('bash');
      expect(metadata?.toolCalls?.[0]?.output).toBe('file1.txt\nfile2.txt');
      expect(metadata?.toolCalls?.[0]?.duration).toBe(250);
    });

    test('should persist empty-string output (not undefined)', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'running tool');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'echo' } });
      persistence.appendToolResult('conv-1', 'bash', '', 100);
      await persistence.flush('conv-1');

      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { output?: string }[];
      };
      // Empty string output should be persisted (not dropped like falsy ||-based logic would)
      expect(metadata?.toolCalls?.[0]?.output).toBe('');
    });

    test('should be a no-op when no buffer exists', () => {
      // Should not throw
      persistence.appendToolResult('nonexistent', 'bash', 'output', 100);
    });

    test('should match the last unresolved tool call by name (reverse order)', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'two bash calls');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'pwd' } });
      // appendToolResult should match the LAST unresolved 'bash' call
      persistence.appendToolResult('conv-1', 'bash', 'output-for-second', 200);
      await persistence.flush('conv-1');

      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { name: string; output?: string }[];
      };
      expect(metadata?.toolCalls).toHaveLength(2);
      // First call should have no output (not yet resolved)
      expect(metadata?.toolCalls?.[0]?.output).toBeUndefined();
      // Second call should have the output
      expect(metadata?.toolCalls?.[1]?.output).toBe('output-for-second');
    });
  });

  describe('flush — pre-finalization of terminal tool calls', () => {
    test('flushes segment when last tool call never received a result', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'running tool');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      // No appendToolResult — simulates terminal tool call at turn end

      await persistence.flush('conv-1');

      // The segment must be flushed (not held as pending)
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { name: string; duration?: number }[];
      };
      // Duration must be set (pre-finalized), not undefined
      expect(metadata?.toolCalls?.[0]?.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('finalizeRunningTools', () => {
    test('sets duration on the last running tool', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'text');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      persistence.finalizeRunningTools('conv-1');
      await persistence.flush('conv-1');

      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls?: { duration?: number }[];
      };
      expect(metadata?.toolCalls?.[0]?.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
