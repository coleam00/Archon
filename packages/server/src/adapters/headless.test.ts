import { describe, test, expect, mock } from 'bun:test';

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
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info' as const,
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockAddMessage = mock(async (..._args: unknown[]) => undefined as unknown);
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));

import { HeadlessPlatform } from './headless';

describe('HeadlessPlatform', () => {
  test('reports platform type and streaming mode', () => {
    const platform = new HeadlessPlatform('conv-db-1');
    expect(platform.getPlatformType()).toBe('api');
    expect(platform.getStreamingMode()).toBe('batch');
  });

  test('sendMessage persists to the bound conversation, ignoring the caller-supplied id', async () => {
    mockAddMessage.mockClear();
    const platform = new HeadlessPlatform('conv-db-1');
    await platform.sendMessage('irrelevant-caller-id', 'hello');
    expect(mockAddMessage).toHaveBeenCalledWith('conv-db-1', 'assistant', 'hello', undefined);
  });

  test('sendMessage forwards known metadata categories', async () => {
    mockAddMessage.mockClear();
    const platform = new HeadlessPlatform('conv-db-1');
    await platform.sendMessage('ignored', 'done', { category: 'workflow_status' });
    expect(mockAddMessage).toHaveBeenCalledWith('conv-db-1', 'assistant', 'done', {
      category: 'workflow_status',
    });
  });

  test('sendMessage swallows a persistence failure instead of throwing', async () => {
    mockAddMessage.mockClear();
    mockAddMessage.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    const platform = new HeadlessPlatform('conv-db-1');
    await expect(platform.sendMessage('ignored', 'hello')).resolves.toBeUndefined();
  });

  test('persists every future WorkflowMessageMetadata field by derivation (#2709)', async () => {
    mockAddMessage.mockClear();
    const platform = new HeadlessPlatform('conv-db-1');
    await platform.sendMessage('ignored', 'done', {
      category: 'workflow_status',
      segment: 'new',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ traceId: 'trace-abc' } as any),
    } as Parameters<typeof platform.sendMessage>[2]);
    expect(mockAddMessage).toHaveBeenCalledWith('conv-db-1', 'assistant', 'done', {
      category: 'workflow_status',
      traceId: 'trace-abc',
    });
  });
});
