import type { IPlatformAdapter, MessageMetadata } from '../../types';
import { mock, type Mock } from 'bun:test';

export class MockPlatformAdapter implements IPlatformAdapter {
  public sendMessage: Mock<
    (conversationId: string, message: string, metadata?: MessageMetadata) => Promise<void>
  > = mock(() => Promise.resolve());
  public ensureThread: Mock<
    (originalConversationId: string, messageContext?: unknown) => Promise<string>
  > = mock((originalConversationId: string) => Promise.resolve(originalConversationId));
  public getStreamingMode: Mock<() => 'stream' | 'batch'> = mock(() => 'stream' as const);
  public getPlatformType: Mock<() => string> = mock(() => 'mock');
  public start: Mock<() => Promise<void>> = mock(() => Promise.resolve());
  public stop: Mock<() => void> = mock(() => undefined);

  public reset(): void {
    this.sendMessage.mockClear();
    this.ensureThread.mockClear();
    this.getStreamingMode.mockClear();
    this.getPlatformType.mockClear();
    this.start.mockClear();
    this.stop.mockClear();
  }
}

export const createMockPlatform = (): MockPlatformAdapter => new MockPlatformAdapter();
