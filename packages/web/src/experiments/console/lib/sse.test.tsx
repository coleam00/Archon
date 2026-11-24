import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactElement } from 'react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useAttentionStreamSSE, useConversationSSE, useDashboardSSE } from './sse';

class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = mock(() => {});

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  lock(locked: boolean): void {
    this.send({ type: 'conversation_lock', locked });
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

    await act(async () => dom.dispatchEvent(new dom.Event('pagehide')));
    expect(stream.close).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invalidate(key);
  }
  expect(TestEventSource.instances.at(-1)?.close).toHaveBeenCalledTimes(1);
});

test('a run or node change on the dashboard stream refetches the factory item pages and item reads', async () => {
  const pageKey = K.factoryItems('project-1');
  const itemKey = K.factoryItem('project-1', '6');
  const loadItems = mock(async () => ['page']);
  const loadItem = mock(async () => ['item']);
  const onRunChanged = (): void => {};

  function Board(): ReactElement {
    useDashboardSSE(onRunChanged);
    const page = useEntity(pageKey, loadItems);
    const item = useEntity(itemKey, loadItem);
    return <div>{[...(page.data ?? []), ...(item.data ?? [])].join('')}</div>;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Board />));
    expect([loadItems, loadItem].map(load => load.mock.calls.length)).toEqual([1, 1]);
    const stream = TestEventSource.instances.at(-1);
    if (!stream) throw new Error('Dashboard stream was not opened');
    const send = (event: object): void => stream.onmessage?.({ data: JSON.stringify(event) });

    await act(async () => send({ type: 'heartbeat' }));
    expect([loadItems, loadItem].map(load => load.mock.calls.length)).toEqual([1, 1]);
    await act(async () => send({ type: 'workflow_status', runId: 'run-1' }));
    expect([loadItems, loadItem].map(load => load.mock.calls.length)).toEqual([2, 2]);
    await act(async () => send({ type: 'dag_node', runId: 'run-1' }));
    expect([loadItems, loadItem].map(load => load.mock.calls.length)).toEqual([3, 3]);

    // A full page load unloads the document without unmounting React: the stream must close
    // on pagehide, or the old page keeps its socket (#39).
    await act(async () => dom.dispatchEvent(new dom.Event('pagehide')));
    expect(stream.close).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('the attention stream refetches the attention list, and reopens on a bad cursor', async () => {
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
    expect(stream.url).toBe('/api/runs/attention/stream?level=quiet');

    await act(async () => {
      stream.send({ type: 'resolved', ref: 'ask:a1' });
      await settle();
    });
    expect(loadAttention).toHaveBeenCalledTimes(2);

    await act(async () => {
      stream.send({ type: 'error', error: 'cursor_invalid' });
      await settle();
    });
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(TestEventSource.instances.at(-1)).not.toBe(stream);
    expect(loadAttention).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invalidate(K.runsAttention);
  }
});
