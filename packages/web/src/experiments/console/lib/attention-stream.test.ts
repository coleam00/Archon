import { expect, test } from 'bun:test';
import { subscribeKey } from '../store/cache';
import { K } from '../store/keys';
import {
  refreshOnAttentionChange,
  watchAttentionStream,
  type AttentionEventSource,
} from './attention-stream';

class FakeSource implements AttentionEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  closed = false;
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  send(type: string): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type, cursor: '1' }) }));
  }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 300));

function watch(page: EventTarget = new EventTarget()): {
  sources: FakeSource[];
  changes: () => number;
  stop: () => void;
} {
  const sources: FakeSource[] = [];
  let changes = 0;
  const stop = watchAttentionStream(
    '/api/runs/attention/stream?project=cb-1',
    () => {
      changes += 1;
    },
    () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    page
  );
  return { sources, changes: () => changes, stop };
}

test('a burst of lines refetches once, and a bookmark alone refetches nothing', async () => {
  const { sources, changes, stop } = watch();
  const [source] = sources;
  source?.send('attention');
  source?.send('ready');
  await settle();
  expect(changes()).toBe(1);

  source?.send('bookmark');
  await settle();
  expect(changes()).toBe(1);

  source?.send('resolved');
  source?.send('terminal');
  await settle();
  expect(changes()).toBe(2);
  stop();
});

test('a cursor error starts a fresh stream; stopping closes it and drops a pending refetch', async () => {
  const { sources, changes, stop } = watch();
  sources[0]?.send('error');
  expect(sources[0]?.closed).toBe(true);
  expect(sources).toHaveLength(2);

  sources[1]?.send('attention');
  stop();
  await settle();
  expect(sources[1]?.closed).toBe(true);
  expect(changes()).toBe(0);
});

test('hiding the page closes the stream, and a restore from the back/forward cache opens a fresh one', async () => {
  const page = new EventTarget();
  const { sources, changes, stop } = watch(page);
  sources[0]?.send('attention');
  page.dispatchEvent(new Event('pagehide'));
  expect(sources[0]?.closed).toBe(true);
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  expect(sources).toHaveLength(2);
  expect(sources[1]?.closed).toBe(false);

  // A cursor error after the restore still starts a fresh stream.
  sources[1]?.send('error');
  expect(sources).toHaveLength(3);

  stop();
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  await settle();
  expect(sources).toHaveLength(3);
  expect(sources[2]?.closed).toBe(true);
  // The line sent before the page hid refetches nothing once its connection is gone.
  expect(changes()).toBe(0);
});

test("an attention change refreshes the project's queue and item reads, not another project's", async () => {
  const loads: string[] = [];
  const keys = [
    K.projectAttention('p1'),
    K.factoryItems('p1'),
    K.factoryItem('p1', '6'),
    K.factoryItem('p2', '6'),
  ];
  const unsubscribe = keys.map(key =>
    subscribeKey(
      key,
      () => {},
      async () => {
        loads.push(key);
        return key;
      }
    )
  );
  const loaded = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  // Let the first loads settle, so the refresh below starts loads of its own.
  await loaded();
  loads.length = 0;
  refreshOnAttentionChange('p1');
  await loaded();
  for (const stop of unsubscribe) stop();
  expect(loads.sort()).toEqual(keys.slice(0, 3).sort());
});
