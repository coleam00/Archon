import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactElement } from 'react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useConversationSSE } from './sse';

class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = mock(() => {});

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  lock(locked: boolean): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'conversation_lock', locked }) });
  }
}

const dom = new Window({ url: 'http://localhost' });
const globals = {
  window: dom,
  document: dom.document,
  EventSource: TestEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('unlock refetches the persisted reply and updates the subscribed chat view', async () => {
  const conversationId = 'unlock-regression';
  const key = K.messages(conversationId);
  let persisted = ['User question'];
  const loadMessages = mock(async () => [...persisted]);

  function Chat(): ReactElement {
    const [locked, setLocked] = useState(false);
    useConversationSSE(conversationId, setLocked);
    const { data } = useEntity(key, loadMessages);
    return <div data-locked={locked}>{data?.join('\n')}</div>;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Chat />));
    expect(container.textContent).toBe('User question');
    expect(loadMessages).toHaveBeenCalledTimes(1);
    const stream = TestEventSource.instances.at(-1);
    if (!stream) throw new Error('Conversation stream was not opened');
    expect(stream.url).toBe(`/api/stream/${conversationId}`);

    await act(async () => stream.lock(true));
    expect(container.firstElementChild?.getAttribute('data-locked')).toBe('true');
    expect(loadMessages).toHaveBeenCalledTimes(1);

    persisted = [...persisted, 'Persisted assistant reply'];
    await act(async () => stream.lock(false));
    expect(loadMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('User question\nPersisted assistant reply');
    expect(container.firstElementChild?.getAttribute('data-locked')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invalidate(key);
  }
  expect(TestEventSource.instances.at(-1)?.close).toHaveBeenCalledTimes(1);
});
