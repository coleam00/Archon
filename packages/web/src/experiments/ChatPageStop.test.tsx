import { afterAll, afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { invalidate, set } from './console/store/cache';
import { K } from './console/store/keys';
import { toMessage } from './console/primitives/message';
import { ChatPage } from './console/routes/ChatPage';

const dom = new Window({ url: 'http://localhost' });

/** The one conversation stream the page opens; the test plays the server's events into it. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  static readonly CLOSED = 2;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(event: object): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const globals = {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  EventSource: FakeEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
let router: ReturnType<typeof createMemoryRouter>;
const container = document.createElement('div');
const originalFetch = globalThis.fetch;
const CONV = 'web-1-abc';
const requests: string[] = [];

beforeEach(() => {
  requests.length = 0;
  set(K.project('project-1'), {
    id: 'project-1',
    name: 'demo',
    path: '/tmp/demo',
    defaultBranch: null,
    repositoryUrl: null,
    lastSyncedAt: null,
    kind: 'folder',
  });
  set(K.conversations('project-1'), [
    { id: CONV, title: 'Chat', platformType: 'web', lastActivityAt: null },
  ]);
  // A reply that has started: the trailing message is the agent's, so only the
  // server's lock says the turn is still running.
  set(
    K.messages(CONV),
    [
      { id: 'm1', role: 'user' as const, content: 'Run the long job' },
      { id: 'm2', role: 'assistant' as const, content: 'Starting the job.' },
    ].map(m =>
      toMessage({
        ...m,
        metadata: '{}',
        created_at: '2026-11-23T10:00:00.000Z',
      })
    )
  );
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith(`/api/conversations/${CONV}/cancel`)) {
        return Response.json({ cancelled: true });
      }
      return Response.json([]);
    },
    { preconnect: originalFetch.preconnect }
  );
  document.body.append(container);
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => root?.unmount());
  root = undefined;
  router.dispose();
  container.remove();
  invalidate(K.project('project-1'));
  invalidate(K.conversations('project-1'));
  invalidate(K.messages(CONV));
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function stopButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    b => b.getAttribute('aria-label') === 'Stop response'
  );
}

test('Stop stays while the server holds the turn, calls cancel, and goes when the turn ends', async () => {
  jest.useFakeTimers();
  router = createMemoryRouter([{ path: '/console/p/:projectId/chat', element: <ChatPage /> }], {
    initialEntries: ['/console/p/project-1/chat'],
  });
  root = createRoot(container);
  await act(async () => root?.render(<RouterProvider router={router} />));
  expect(FakeEventSource.last?.url).toContain(`/api/stream/${CONV}`);

  await act(async () => FakeEventSource.last?.emit({ type: 'conversation_lock', locked: true }));
  expect(stopButton()).toBeDefined();

  // A long tool call: no new message for longer than the settle window.
  await act(async () => jest.advanceTimersByTime(10_000));
  expect(stopButton()).toBeDefined();

  await act(async () => stopButton()?.click());
  expect(requests).toContain(`POST /api/conversations/${CONV}/cancel`);

  await act(async () => FakeEventSource.last?.emit({ type: 'conversation_lock', locked: false }));
  expect(stopButton()).toBeUndefined();
});
