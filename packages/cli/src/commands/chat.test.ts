/**
 * Tests for the CLI chat command
 */
import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import type { handleMessage } from '@archon/core';
import { Readable, PassThrough } from 'node:stream';
import * as readline from 'node:readline';

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

import { chatCommand as runChat } from './chat';
import { CLIAdapter } from '../adapters/cli-adapter';

const chatCommand = (message: string): Promise<void> => runChat(message, Readable.from([]));

beforeEach(() => {
  mockHandleMessage.mockReset();
  mockHandleMessage.mockResolvedValue(undefined);
});

describe('chatCommand', () => {
  test('should call handleMessage with a CLIAdapter, unique conversationId, and the message', async () => {
    await chatCommand('Hello, agent!');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);

    const [adapter, conversationId, message] = mockHandleMessage.mock.calls[0];

    expect(adapter).toBeInstanceOf(CLIAdapter);
    expect(conversationId).toMatch(/^cli-chat-\d+-[a-f0-9]{32}$/);
    expect(message).toBe('Hello, agent!');
  });

  test('should use batch streaming mode for the CLIAdapter', async () => {
    await chatCommand('test');

    const [adapter] = mockHandleMessage.mock.calls[0];
    expect(adapter.getStreamingMode()).toBe('batch');
  });

  test('should generate a unique conversationId for each invocation', async () => {
    await chatCommand('first message');
    await chatCommand('second message');

    const [, id1] = mockHandleMessage.mock.calls[0];
    const [, id2] = mockHandleMessage.mock.calls[1];

    expect(id1).not.toBe(id2);
  });

  test('should forward the exact message string to handleMessage', async () => {
    const complexMessage = '/workflow run assist "build a feature"';
    await chatCommand(complexMessage);

    const [, , message] = mockHandleMessage.mock.calls[0];
    expect(message).toBe(complexMessage);
  });

  test('should propagate errors thrown by handleMessage', async () => {
    mockHandleMessage.mockRejectedValueOnce(new Error('Orchestrator unavailable'));

    await expect(chatCommand('will fail')).rejects.toThrow('Orchestrator unavailable');
  });

  test('should have conversationId prefixed with cli-chat-', async () => {
    await chatCommand('prefix check');

    const [, conversationId] = mockHandleMessage.mock.calls[0];
    expect(conversationId.startsWith('cli-chat-')).toBe(true);
  });

  test('CLIAdapter passed to handleMessage should have cli platform type', async () => {
    await chatCommand('platform type check');

    const [adapter] = mockHandleMessage.mock.calls[0];
    expect(adapter.getPlatformType()).toBe('cli');
  });

  test('empty input exits without dispatching a turn', async () => {
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await chatCommand('');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

test('interactive input retains one adapter and conversation, awaits each turn, and exits explicitly', async () => {
  const input = new PassThrough();
  const received: string[] = [];
  mockHandleMessage.mockImplementation(async (adapter, conversationId, message, options) => {
    expect(options).toEqual({ actor: { kind: 'operator' } });
    received.push(message);
    await adapter.sendMessage(conversationId, `reply: ${message}`);
  });
  const logged = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const session = runChat(undefined, input);
    input.end('/setproject alpha\n\ninspect runs\n/exit\nnever sent\n');
    await session;
    expect(received).toEqual(['/setproject alpha', 'inspect runs']);
    const [first, second] = mockHandleMessage.mock.calls;
    expect(first[0]).toBe(second[0]);
    expect(first[1]).toBe(second[1]);
    expect(logged.mock.calls.map(args => args[0])).toEqual([
      'reply: /setproject alpha',
      'reply: inspect runs',
    ]);
  } finally {
    logged.mockRestore();
    input.destroy();
  }
});

test('piped follow-ups survive an initial async turn and EOF closes the session', async () => {
  const received: string[] = [];
  mockHandleMessage.mockImplementation(async (_adapter, _conversationId, message) => {
    await Promise.resolve();
    received.push(message);
  });
  await runChat('initial', Readable.from(['follow up\nlast turn\n']));
  expect(received).toEqual(['initial', 'follow up', 'last turn']);
  expect(new Set(mockHandleMessage.mock.calls.map(call => call[1])).size).toBe(1);
});

test('an interactive turn failure propagates and stops further dispatch', async () => {
  mockHandleMessage
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('turn failed'));
  await expect(runChat(undefined, Readable.from(['first\nsecond\nthird\n']))).rejects.toThrow(
    'turn failed'
  );
  expect(mockHandleMessage.mock.calls.map(call => call[2])).toEqual(['first', 'second']);
});

test.each([undefined, 'initial'])(
  'Ctrl-C during a turn stops buffered dispatch (initial: %s)',
  async initial => {
    const input = new PassThrough();
    const lines = readline.createInterface({ input });
    const createInterface = spyOn(readline, 'createInterface').mockReturnValue(lines);
    const started = Promise.withResolvers<void>();
    const turn = Promise.withResolvers<void>();
    mockHandleMessage.mockImplementation(async () => {
      started.resolve();
      await turn.promise;
    });
    const session = runChat(initial, input);
    try {
      if (!initial) input.write('first\n');
      await started.promise;
      input.write('/setproject beta\ncancel a run\n');
      lines.emit('SIGINT');
      turn.resolve();
      await session;
      expect(mockHandleMessage.mock.calls.map(call => call[2])).toEqual([initial ?? 'first']);
    } finally {
      turn.resolve();
      lines.close();
      input.destroy();
      createInterface.mockRestore();
      await session;
    }
  }
);
