import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useRunsRefresh } from './RunsPage';

const dom = new Window({ url: 'http://localhost' });
const ticks: (() => void)[] = [];
const globals = {
  window: dom,
  document: dom.document,
  IS_REACT_ACT_ENVIRONMENT: true,
  setInterval: (tick: () => void): number => ticks.push(tick),
  clearInterval: (id: number): void => {
    ticks[id - 1] = () => undefined;
  },
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

test('the runs feed is refetched on a timer while it lists a running run, and not otherwise', async () => {
  const load = mock(async () => 'feed');
  function Feed({ hasRunning }: { hasRunning: boolean }): ReactElement {
    useEntity(K.runs('refresh-test'), load);
    useRunsRefresh('refresh-test', hasRunning);
    return <div />;
  }
  const tick = async (): Promise<void> => {
    await act(async () => {
      for (const run of ticks) run();
      await Promise.resolve();
    });
  };
  const root = createRoot(dom.document.createElement('div') as unknown as Element);
  try {
    await act(async () => {
      root.render(<Feed hasRunning={false} />);
    });
    await tick();
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<Feed hasRunning />);
    });
    await tick();
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(<Feed hasRunning={false} />);
    });
    await tick();
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
