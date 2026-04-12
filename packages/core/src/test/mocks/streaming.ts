import { mock, type Mock } from 'bun:test';

export interface StreamEvent {
  type: 'text' | 'tool' | 'error' | 'complete';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: Error;
}

export async function* createMockStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

export const createMockAgentProvider = (
  events: StreamEvent[] = []
): {
  sendMessage: Mock<() => AsyncGenerator<StreamEvent>>;
  getType: Mock<() => string>;
  resumeSession: Mock<() => AsyncGenerator<StreamEvent>>;
} => ({
  sendMessage: mock(async function* () {
    for (const event of events) {
      yield event;
    }
  }),
  getType: mock(() => 'claude'),
  resumeSession: mock(async function* () {
    for (const event of events) {
      yield event;
    }
  }),
});
