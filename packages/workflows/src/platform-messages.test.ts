// @archon-test-isolated
import { describe, it, expect, mock, type Mock } from 'bun:test';

// Mock logger before importing module under test
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import type { IWorkflowPlatform } from './deps';
import { safeSendMessage } from './platform-messages';

describe('safeSendMessage', () => {
  const platformThat = (send: () => Promise<void>): IWorkflowPlatform =>
    ({
      sendMessage: mock(send),
      getPlatformType: mock(() => 'test'),
    }) as unknown as IWorkflowPlatform;

  it('returns true when the platform accepts the message', async () => {
    expect(
      await safeSendMessage(
        platformThat(() => Promise.resolve()),
        'conv-1',
        'hello'
      )
    ).toBe(true);
  });

  it('logs and suppresses a send failure whatever it says', async () => {
    for (const message of ['401 unauthorized', 'timeout connecting', 'some unclassified glitch']) {
      mockLogFn.mockClear();
      const sent = await safeSendMessage(
        platformThat(() => Promise.reject(new Error(message))),
        'conv-1',
        'hello'
      );
      expect(sent).toBe(false);
      expect(
        (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
          call => call[1] === 'platform_message_send_failed'
        )
      ).toBe(true);
    }
  });
});
