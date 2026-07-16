import { describe, test, expect } from 'bun:test';
import { subscribeKey, versionOf, get, set, invalidate } from './cache';

// The store's Maps are module-level, so every test uses its own unique key —
// no cross-test state to reset.

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('subscribeKey — per-key lifecycle', () => {
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

  test('resubscribing supersedes an abandoned in-flight loader', async () => {
    const key = 'test:resubscribe-inflight';
    let resolveA: (v: string) => void = () => {};
    let resolveB: (v: string) => void = () => {};
    let loadsA = 0;
    let loadsB = 0;

    const unsubscribeA = subscribeKey(
      key,
      () => {},
      () => {
        loadsA += 1;
        return new Promise<string>(resolve => {
          resolveA = resolve;
        });
      }
    );
    expect(loadsA).toBe(1);

    unsubscribeA();

    let notificationsB = 0;
    const unsubscribeB = subscribeKey(
      key,
      () => {
        notificationsB += 1;
      },
      () => {
        loadsB += 1;
        return new Promise<string>(resolve => {
          resolveB = resolve;
        });
      }
    );

    expect(loadsB).toBe(1);

    resolveB('fresh');
    await flush();
    expect(get(key)).toBe('fresh');
    expect(notificationsB).toBe(1);

    resolveA('stale');
    await flush();
    expect(get(key)).toBe('fresh');
    expect(notificationsB).toBe(1);

    unsubscribeB();
  });

  test('an abandoned revalidation cannot overwrite a warm remount', async () => {
    const key = 'test:resubscribe-revalidation';
    set(key, 'warm');

    let resolveA: (v: string) => void = () => {};
    const unsubscribeA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveA = resolve;
        })
    );
    invalidate(key); // Starts a revalidation while retaining the warm value.
    unsubscribeA();

    let loadsB = 0;
    let notificationsB = 0;
    const unsubscribeB = subscribeKey(
      key,
      () => {
        notificationsB += 1;
      },
      () => {
        loadsB += 1;
        return Promise.resolve('fresh');
      }
    );

    expect(loadsB).toBe(0); // The retained cache still satisfies a warm remount.

    resolveA('stale');
    await flush();
    expect(get(key)).toBe('warm');
    expect(notificationsB).toBe(0);

    unsubscribeB();
  });

  test('invalidating an abandoned revalidation cannot resurrect a purged key', async () => {
    const key = 'test:invalidate-abandoned-revalidation';
    set(key, 'warm');

    let resolveLoad: (v: string) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        })
    );

    invalidate(key);
    unsubscribe();
    invalidate(key);
    expect(get(key)).toBeUndefined();

    resolveLoad('stale');
    await flush();
    expect(get(key)).toBeUndefined();
  });

  test('manual revalidation supersedes an abandoned load', async () => {
    const key = 'test:supersede-abandoned-revalidation';
    set(key, 'warm');

    let resolveA: (v: string) => void = () => {};
    const unsubscribeA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveA = resolve;
        })
    );
    invalidate(key);
    unsubscribeA();

    let loadsB = 0;
    let resolveB: (v: string) => void = () => {};
    const unsubscribeB = subscribeKey(
      key,
      () => {},
      () => {
        loadsB += 1;
        return new Promise<string>(resolve => {
          resolveB = resolve;
        });
      }
    );

    invalidate(key);
    expect(loadsB).toBe(1);

    resolveB('fresh');
    await flush();
    expect(get(key)).toBe('fresh');

    resolveA('stale');
    await flush();
    expect(get(key)).toBe('fresh');

    unsubscribeB();
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
