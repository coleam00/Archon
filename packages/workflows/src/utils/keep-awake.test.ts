import { describe, test, expect } from 'bun:test';
import { createKeepAwake } from './keep-awake';

// Expected flag values the native fn should receive.
const ACQUIRE = 0x80000001; // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, unsigned
const RELEASE = 0x80000000; // ES_CONTINUOUS alone (clears prior flags)

/** A fake SetThreadExecutionState that records the flags it was called with. */
function makeFake(returnValue = 1): { fn: (flags: number) => number; calls: number[] } {
  const calls: number[] = [];
  return {
    fn: (flags: number): number => {
      calls.push(flags);
      return returnValue;
    },
    calls,
  };
}

describe('createKeepAwake (win32)', () => {
  test('first acquire fires ES_CONTINUOUS|ES_SYSTEM_REQUIRED; nested acquire does not re-fire', () => {
    const fake = makeFake();
    const ka = createKeepAwake(fake.fn, 'win32');

    ka.acquire();
    expect(fake.calls).toEqual([ACQUIRE]);
    expect(ka.activeCount()).toBe(1);

    ka.acquire();
    expect(fake.calls).toEqual([ACQUIRE]); // still exactly one call
    expect(ka.activeCount()).toBe(2);
  });

  test('release from 2→1 does not clear; 1→0 clears with ES_CONTINUOUS', () => {
    const fake = makeFake();
    const ka = createKeepAwake(fake.fn, 'win32');

    ka.acquire();
    ka.acquire();
    fake.calls.length = 0; // ignore the single acquire call

    ka.release(); // 2 → 1
    expect(fake.calls).toEqual([]);
    expect(ka.activeCount()).toBe(1);

    ka.release(); // 1 → 0
    expect(fake.calls).toEqual([RELEASE]);
    expect(ka.activeCount()).toBe(0);
  });

  test('re-acquire after full release fires the native call again', () => {
    const fake = makeFake();
    const ka = createKeepAwake(fake.fn, 'win32');

    ka.acquire(); // 0 → 1: ACQUIRE
    ka.release(); // 1 → 0: RELEASE
    ka.acquire(); // 0 → 1: ACQUIRE

    expect(fake.calls).toEqual([ACQUIRE, RELEASE, ACQUIRE]);
    expect(ka.activeCount()).toBe(1);
  });

  test('unbalanced release at refcount 0 makes no native call and does not throw', () => {
    const fake = makeFake();
    const ka = createKeepAwake(fake.fn, 'win32');

    expect(() => ka.release()).not.toThrow();
    expect(fake.calls).toEqual([]);
    expect(ka.activeCount()).toBe(0);
  });

  test('native failure (returns 0) does not throw and still increments refcount', () => {
    const fake = makeFake(0); // 0 = API failure signal
    const ka = createKeepAwake(fake.fn, 'win32');

    expect(() => ka.acquire()).not.toThrow();
    expect(fake.calls).toEqual([ACQUIRE]);
    expect(ka.activeCount()).toBe(1); // refcount tracked so release stays paired

    ka.release(); // 1 → 0 still fires the clear
    expect(fake.calls).toEqual([ACQUIRE, RELEASE]);
    expect(ka.activeCount()).toBe(0);
  });

  test('a THROWING native fn never propagates and keeps the refcount paired', () => {
    let calls = 0;
    const throwing = (): number => {
      calls += 1;
      throw new Error('FFI call failed');
    };
    const ka = createKeepAwake(throwing, 'win32');

    expect(() => ka.acquire()).not.toThrow();
    expect(ka.activeCount()).toBe(1);

    expect(() => ka.release()).not.toThrow();
    expect(ka.activeCount()).toBe(0);

    expect(calls).toBe(2); // both the 0→1 and 1→0 transitions attempted the call
  });
});

describe('createKeepAwake (disabled: non-win32 or no native fn)', () => {
  test('non-win32 platform never calls the native fn but tracks refcount', () => {
    const fake = makeFake();
    const ka = createKeepAwake(fake.fn, 'linux');

    ka.acquire();
    ka.acquire();
    ka.release();
    ka.release();

    expect(fake.calls).toEqual([]);
    expect(ka.activeCount()).toBe(0);
  });

  test('undefined native fn on win32 is a safe no-op with refcount tracking', () => {
    const ka = createKeepAwake(undefined, 'win32');

    expect(() => {
      ka.acquire();
      ka.acquire();
      ka.release();
    }).not.toThrow();
    expect(ka.activeCount()).toBe(1);
  });
});
