import { afterAll, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProjectAttentionLayout } from '../components/ProjectAttention';
import { invalidate } from '../store/cache';
import { FactoryFrame } from './FactoryFrame';
import { FACTORY_READ_DEADLINE_MS } from './lib/deadline';

const dom = new Window({ url: 'http://localhost' });
/** The project's attention stream, which says nothing here. */
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;

afterAll(async () => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  invalidate('factory-views');
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const ID = 'cb-frame-stall';

test('a stalled first views read, on a cold page load, says so and is retried', async () => {
  jest.useFakeTimers();
  // Every request stalls until aborted, as one queued behind a full connection pool does.
  const views: { signal: boolean }[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/api/factory/views')) views.push({ signal: !!init?.signal });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
    { preconnect: originalFetch.preconnect }
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const status = (): string =>
    [...container.querySelectorAll('[role=status]')].map(node => node.textContent).join('|');
  try {
    // The frame renders the project tabs, which read the same views key: whichever mounts
    // first starts the read, and it must be under the deadline either way.
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/console/p/${ID}/factory`]}>
          <Routes>
            <Route path="/console/p/:projectId" element={<ProjectAttentionLayout />}>
              <Route
                path="factory"
                element={<FactoryFrame section="overview">{() => null}</FactoryFrame>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      )
    );
    const label = status();
    expect(views).toEqual([{ signal: true }]);

    await act(async () => {
      jest.advanceTimersByTime(FACTORY_READ_DEADLINE_MS);
    });
    expect(status()).not.toBe(label);
    expect(status()).not.toBe('');

    // The retry, after its wait, asks again.
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(views).toEqual([{ signal: true }, { signal: true }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
