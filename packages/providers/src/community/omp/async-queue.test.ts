import { describe, expect, test } from 'bun:test';

import { AsyncQueue } from './async-queue';

describe('AsyncQueue', () => {
  test('rejects undefined items explicitly', () => {
    const queue = new AsyncQueue<unknown>();

    expect(() => queue.push(undefined)).toThrow(
      'AsyncQueue cannot enqueue undefined; use null or a caller-owned sentinel object'
    );
  });

  test('yields queued items until closed', async () => {
    const queue = new AsyncQueue<string>();
    queue.push('first');
    queue.push('second');
    queue.close();

    const items: string[] = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual(['first', 'second']);
  });

  test('accepts null items', async () => {
    const queue = new AsyncQueue<string | null>();
    queue.push(null);
    queue.push('after-null');
    queue.close();

    const items: Array<string | null> = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual([null, 'after-null']);
  });

  test('iteration completes immediately on empty closed queue', async () => {
    const queue = new AsyncQueue<string>();
    queue.close();

    const items: string[] = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual([]);
  });

  test('yields items pushed after iteration starts', async () => {
    const queue = new AsyncQueue<string>();
    const items: string[] = [];

    const consume = (async () => {
      for await (const item of queue) {
        items.push(item);
      }
    })();

    await Promise.resolve();
    queue.push('first');
    queue.push('second');
    queue.close();
    await consume;

    expect(items).toEqual(['first', 'second']);
  });

  test('return settles a pending next without waiting for push or close', async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    if (!iterator.return) throw new Error('AsyncQueue iterator is missing return()');

    await expect(iterator.return()).resolves.toEqual({ value: undefined, done: true });
    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
