import { describe, test, expect } from 'bun:test';
import { subscribeKey, versionOf, get, set, invalidate } from './cache';

// The store's Maps are module-level, so every test uses its own unique key —
// no cross-test state to reset.

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('subscribeKey — per-key Map lifecycle (#1933)', () => {
  test('last unsubscribe prunes versions; cache is retained for warm remount', async () => {
    const key = 'test:prune-versions';
    let loads = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v1');
      }
    );
    await flush();

    expect(get(key)).toBe('v1');
    expect(versionOf(key)).toBe(1); // notify bumped on load resolve
    expect(loads).toBe(1);

    unsubscribe();
    expect(versionOf(key)).toBe(0); // counter released
    expect(get(key)).toBe('v1'); // cached value deliberately retained

    // Remount reads warm: ensureLoad short-circuits on the cached value.
    const unsubscribe2 = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v2');
      }
    );
    await flush();
    expect(get(key)).toBe('v1');
    expect(loads).toBe(1); // loader not re-invoked
    unsubscribe2();
  });

  test('unsubscribing a non-last subscriber keeps the counter', async () => {
    const key = 'test:non-last';
    const unsubA = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    const unsubB = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    await flush();
    expect(versionOf(key)).toBe(1);

    unsubA();
    expect(versionOf(key)).toBe(1); // B still subscribed

    unsubB();
    expect(versionOf(key)).toBe(0);
  });

  test('unsubscribe stops change notifications', async () => {
    const key = 'test:notify-stops';
    let renders = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {
        renders += 1;
      },
      () => Promise.resolve('a')
    );
    await flush();
    expect(renders).toBe(1);

    unsubscribe();
    set(key, 'b');
    expect(renders).toBe(1); // no further signal after cleanup
  });

  test('invalidate fully releases a subscriber-less key (cache + versions)', async () => {
    const key = 'test:invalidate-prune';
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    await flush();
    unsubscribe();

    // An SSE push for an unsubscribed key updates the still-warm cache; the
    // version counter stays released because notify skips subscriber-less keys.
    set(key, 'pushed');
    expect(get(key)).toBe('pushed');
    expect(versionOf(key)).toBe(0);

    // With no loader registered, revalidate's prune branch drops the cache too.
    invalidate(key);
    expect(get(key)).toBeUndefined();
    expect(versionOf(key)).toBe(0);
  });

  test('a load resolving after the last unsubscribe does not resurrect the counter', async () => {
    const key = 'test:inflight-resolve';
    let resolveLoad: (v: string) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        })
    );

    unsubscribe(); // last subscriber leaves while the load is still in flight
    expect(versionOf(key)).toBe(0);

    resolveLoad('late');
    await flush();
    expect(versionOf(key)).toBe(0); // notify skipped — nothing subscribes
    expect(get(key)).toBe('late'); // cache still warms for a future remount
  });

  test('a load rejecting after the last unsubscribe does not resurrect the counter', async () => {
    const key = 'test:inflight-reject';
    let rejectLoad: (e: Error) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectLoad = reject;
        })
    );

    unsubscribe();
    expect(versionOf(key)).toBe(0);

    rejectLoad(new Error('late boom'));
    await flush();
    expect(versionOf(key)).toBe(0);
  });

  test('invalidate by prefix releases every matching subscriber-less key', async () => {
    const unsubA = subscribeKey(
      'test-prefix:a',
      () => {},
      () => Promise.resolve('a')
    );
    const unsubB = subscribeKey(
      'test-prefix:b',
      () => {},
      () => Promise.resolve('b')
    );
    await flush();
    unsubA();
    unsubB();

    invalidate('test-prefix');
    expect(get('test-prefix:a')).toBeUndefined();
    expect(get('test-prefix:b')).toBeUndefined();
    expect(versionOf('test-prefix:a')).toBe(0);
    expect(versionOf('test-prefix:b')).toBe(0);
  });

  test('errored key still releases its counter on last unsubscribe', async () => {
    const key = 'test:error-prune';
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => Promise.reject(new Error('boom'))
    );
    await flush();
    expect(get(key)).toBeUndefined();
    expect(versionOf(key)).toBe(1); // error transition notified

    unsubscribe();
    expect(versionOf(key)).toBe(0);
  });
});
