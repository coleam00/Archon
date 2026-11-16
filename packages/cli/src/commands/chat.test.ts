/**
 * Tests for the CLI chat command
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { handleMessage } from '@archon/core';

// Mock logger before any imports
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock handleMessage from @archon/core
const mockHandleMessage = mock<typeof handleMessage>(() => Promise.resolve());

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
}));

import { chatCommand } from './chat';
import { CLIAdapter } from '../adapters/cli-adapter';

describe('chatCommand', () => {
  beforeEach(() => {
    mockHandleMessage.mockReset();
    mockHandleMessage.mockResolvedValue(undefined);
  });

  test('should call handleMessage with a CLIAdapter, unique conversationId, and the message', async () => {
    await chatCommand('Hello, agent!');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);

    const [adapter, conversationId, message] = mockHandleMessage.mock.calls[0];

    expect(adapter).toBeInstanceOf(CLIAdapter);
    expect(conversationId).toMatch(/^cli-chat-\d+-[a-f0-9]{32}$/);
    expect(message).toBe('Hello, agent!');
  });

  test('should propagate errors thrown by handleMessage', async () => {
    mockHandleMessage.mockRejectedValueOnce(new Error('Orchestrator unavailable'));

    await expect(chatCommand('will fail')).rejects.toThrow('Orchestrator unavailable');
  });
});
