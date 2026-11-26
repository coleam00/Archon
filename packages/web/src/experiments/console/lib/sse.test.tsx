import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactElement } from 'react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useAttentionStreamSSE, useConversationSSE } from './sse';

class TestEventSource {
  static instances: TestEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = mock(() => {});

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  lock(locked: boolean): void {
    this.send({ type: 'conversation_lock', locked });
  }

  /** A dropped connection the browser reopens by itself, on the same EventSource. */
  reconnect(): void {
    this.readyState = 0;
    this.onerror?.();
    this.readyState = 1;
    this.onopen?.();
  }

  send(line: object): void {
    this.onmessage?.({ data: JSON.stringify(line) });
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

test('the attention stream refetches on changes after its replay, and reopens on a bad cursor', async () => {
  const loadAttention = mock(async () => 'list');
  function Banner(): ReactElement {
    useAttentionStreamSSE();
    const { data } = useEntity(K.runsAttention, loadAttention);
    return <div>{data}</div>;
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 150));

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Banner />));
    expect(loadAttention).toHaveBeenCalledTimes(1);
    const stream = TestEventSource.instances.at(-1);
    if (!stream) throw new Error('Attention stream was not opened');
    expect(stream.url).toBe('/api/runs/attention/stream?level=protocol');

    // The open set the page's first read already holds, then `ready`: nothing to refetch.
    await act(async () => {
      stream.send({ type: 'attention', needs: 'answer', item: { kind: 'attention' } });
      stream.send({ type: 'attention', needs: 'look', item: { kind: 'stopped' } });
      stream.send({ type: 'ready', cursor: 'c1' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(1);

    // A line that needs no one changes nothing the list shows.
    await act(async () => {
      stream.send({ type: 'attention', needs: 'nothing', item: { kind: 'usage_limit' } });
      stream.send({ type: 'terminal', needs: 'nothing' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(1);

    await act(async () => {
      stream.send({ type: 'resolved', ref: 'ask:a1' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(2);

    await act(async () => {
      stream.send({ type: 'attention', needs: 'answer', item: { kind: 'attention' } });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(3);

    await act(async () => {
      stream.send({ type: 'error', error: 'cursor_invalid' });
      await settle();
    });
    expect(stream.close).toHaveBeenCalledTimes(1);
    const reopened = TestEventSource.instances.at(-1);
    expect(reopened).not.toBe(stream);
    expect(loadAttention).toHaveBeenCalledTimes(4);

    // The reopened stream's replay refetches nothing more; its changes do.
    if (!reopened) throw new Error('Attention stream was not reopened');
    await act(async () => {
      reopened.send({ type: 'attention', needs: 'answer', item: { kind: 'attention' } });
      reopened.send({ type: 'ready', cursor: 'c2' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(4);
    await act(async () => {
      reopened.send({ type: 'resolved', ref: 'ask:a2' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(5);

    // The browser's own reconnect gets the open set and `ready` again: a replay, not news.
    await act(async () => {
      reopened.reconnect();
      reopened.send({ type: 'attention', needs: 'answer', item: { kind: 'attention' } });
      reopened.send({ type: 'ready', cursor: 'c3' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(5);
    await act(async () => {
      reopened.send({ type: 'resolved', ref: 'ask:a3' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invalidate(K.runsAttention);
  }
});
