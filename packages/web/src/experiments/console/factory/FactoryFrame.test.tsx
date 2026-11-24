import { afterEach, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProjectAttentionLayout } from '../components/ProjectAttention';
import { invalidate } from '../store/cache';
import { installDom } from '../test-dom.test-helpers';
import { FactoryFrame } from './FactoryFrame';
import { FACTORY_READ_DEADLINE_MS } from './lib/deadline';

const { mount } = await installDom();
const originalFetch = globalThis.fetch;

// Real timers back before the harness closes the window, which waits on them.
afterEach(() => {
  jest.useRealTimers();
  invalidate('factory-views');
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
  // The frame renders the project tabs, which read the same views key: whichever mounts
  // first starts the read, and it must be under the deadline either way.
  const { container, unmount } = await mount(
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
  );
  const status = (): string =>
    [...container.querySelectorAll('[role=status]')].map(node => node.textContent).join('|');
  try {
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
    await unmount();
  }
});
