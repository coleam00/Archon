import { afterAll, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { invalidate } from '../store/cache';
import { FactoryLoading, SLOW_READ_NOTICE } from './FactoryLoading';
import { FACTORY_READ_DEADLINE_MS } from './lib/deadline';
import { useFactoryRead } from './useFactoryRead';

const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  jest.useRealTimers();
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(): Promise<{
  show: (element: ReactElement) => Promise<void>;
  text: () => string;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    show: async element => act(async () => root.render(element)),
    text: () => container.textContent,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const advance = (ms: number): Promise<void> =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });

/** A read that never answers, as one queued behind a full connection pool; counts attempts. */
function stalled(): { attempts: () => number; read: (signal: AbortSignal) => Promise<string> } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    read: signal => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };
}

test('a read that missed its deadline says so and retries itself, waiting longer each time', async () => {
  jest.useFakeTimers();
  const key = 'factory-stalled-read-test';
  const stall = stalled();
  function Stalled(): ReactElement {
    const read = useFactoryRead(key, within => within(stall.read));
    return <FactoryLoading read={read}>L</FactoryLoading>;
  }
  const page = await mount();
  try {
    await page.show(<Stalled />);
    expect(page.text()).toBe('L');
    expect(stall.attempts()).toBe(1);
    // The 8 s deadline passes: the page says so above its skeleton.
    await advance(FACTORY_READ_DEADLINE_MS);
    expect(page.text()).toBe(`${SLOW_READ_NOTICE}L`);
    await advance(1_999);
    expect(stall.attempts()).toBe(1);
    await advance(1);
    expect(stall.attempts()).toBe(2);
    // The retry has a 16 s deadline; after it misses, the next wait is 4 s, not 2.
    await advance(16_000);
    await advance(3_999);
    expect(stall.attempts()).toBe(2);
    expect(page.text()).toBe(`${SLOW_READ_NOTICE}L`);
    await advance(1);
    expect(stall.attempts()).toBe(3);
  } finally {
    await page.unmount();
    invalidate(key);
  }
});

test('a read slower than the first deadline on every attempt still lands, on a longer one', async () => {
  jest.useFakeTimers();
  const key = 'factory-slow-read-test';
  let attempts = 0;
  // Healthy but slow: every attempt answers after 9 s, past the first 8 s deadline.
  const slowRead = (signal: AbortSignal): Promise<string> => {
    attempts += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve('the data');
      }, 9_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  };
  function Slow(): ReactElement {
    const read = useFactoryRead(key, within => within(slowRead));
    return read.data === undefined ? (
      <FactoryLoading read={read}>L</FactoryLoading>
    ) : (
      <p>{read.data}</p>
    );
  }
  const page = await mount();
  try {
    await page.show(<Slow />);
    expect(page.text()).toBe('L');
    await advance(FACTORY_READ_DEADLINE_MS);
    expect(page.text()).toBe(`${SLOW_READ_NOTICE}L`);
    // The retry, 2 s later, gets a 16 s deadline, which the 9 s answer meets.
    await advance(2_000);
    await advance(9_000);
    expect(page.text()).toBe('the data');
    expect(attempts).toBe(2);
  } finally {
    await page.unmount();
    invalidate(key);
  }
});

test('readers of the same key retry it once between them', async () => {
  jest.useFakeTimers();
  const key = 'factory-shared-read-test';
  const stall = stalled();
  // Each shows nothing while it waits: the retry does not depend on a loading notice.
  function Reader(): null {
    useFactoryRead(key, within => within(stall.read));
    return null;
  }
  const page = await mount();
  try {
    await page.show(
      <>
        <Reader />
        <Reader />
        <Reader />
      </>
    );
    expect(stall.attempts()).toBe(1);
    await advance(FACTORY_READ_DEADLINE_MS);
    await advance(2_000);
    expect(stall.attempts()).toBe(2);
    // Past the retry's 16 s deadline, short of the next 4 s wait. Without the dedup, the other
    // readers' retries, queued behind attempt 2 by the cache, start a third attempt here.
    await advance(16_000);
    expect(stall.attempts()).toBe(2);
  } finally {
    await page.unmount();
    invalidate(key);
  }
});
