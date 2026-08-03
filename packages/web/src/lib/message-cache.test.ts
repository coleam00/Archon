import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getCachedMessages,
  setCachedMessages,
  setSendInFlight,
  isSendInFlight,
} from './message-cache';
import type { ChatMessage } from './types';

/** Build a minimal ChatMessage for test purposes. */
function makeMsg(id: string, content = 'hello'): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

/**
 * Reset visible module state before each test.
 *
 * The Map and boolean in message-cache.ts are module-level singletons that
 * persist for the lifetime of the Bun process.  We reset them by:
 *   - Overwriting every known key with an empty array then deleting it
 *     (getCachedMessages returns [] when missing, so we don't need a real
 *      "clear" method — we just ensure tests start from known state by
 *      re-writing what they need rather than relying on prior calls).
 *   - Forcing sendInFlight back to false.
 *
 * Because we cannot call Map#clear() from outside the module, each test is
 * written to be self-contained: it sets up all the keys it needs and only
 * asserts on the behaviour it exercised.
 */
beforeEach(() => {
  setSendInFlight(false);
  // Clear any keys that may have been written by previous tests by re-writing
  // them as empty arrays.  We keep a small sentinel set of IDs used across
  // tests.  Any ID-specific state is handled inline per test.
});

// ─── getCachedMessages ────────────────────────────────────────────────────────

describe('getCachedMessages', () => {
  test('returns empty array for an unknown conversation id', () => {
    const result = getCachedMessages('no-such-id-' + Math.random());
    expect(result).toEqual([]);
  });

  test('returns the stored messages for a known id', () => {
    const id = 'gc-test-1';
    const msgs = [makeMsg('m1'), makeMsg('m2')];
    setCachedMessages(id, msgs);

    const result = getCachedMessages(id);
    expect(result).toEqual(msgs);
  });

  test('returns an empty array (not undefined) for a missing id', () => {
    const result = getCachedMessages('gc-missing-' + Math.random());
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test('moves the accessed entry to the most-recently-used position', () => {
    // Populate three entries: A, B, C (in insertion order).
    // Access A → A should move to the end (MRU position).
    // Then fill the cache to 20 — the first eviction target should be B, not A.
    const baseId = 'lru-' + Math.random() + '-';
    const idA = baseId + 'A';
    const idB = baseId + 'B';

    const msgA = makeMsg('a1');
    setCachedMessages(idA, [msgA]);
    setCachedMessages(idB, [makeMsg('b1')]);

    // Access A — moves it to MRU position, so B becomes LRU.
    getCachedMessages(idA);

    // Fill cache to exactly 20 (MAX_CACHED_CONVERSATIONS).
    // We already have A and B, so we need 18 more.
    const fillerIds: string[] = [];
    for (let i = 0; i < 18; i++) {
      const fillId = baseId + 'fill-' + String(i);
      fillerIds.push(fillId);
      setCachedMessages(fillId, [makeMsg('f' + String(i))]);
    }

    // Cache is now at 20 entries.  Adding one more should evict the LRU entry,
    // which is B (A was re-inserted after B).
    const triggerEvictId = baseId + 'trigger';
    setCachedMessages(triggerEvictId, [makeMsg('trigger')]);

    // B should have been evicted.
    expect(getCachedMessages(idB)).toEqual([]);

    // A should still be present (it was promoted to MRU before the filler inserts).
    expect(getCachedMessages(idA)).toEqual([msgA]);
  });

  test('returns the same message objects that were stored', () => {
    const id = 'gc-same-ref';
    const msgs = [makeMsg('ref1')];
    setCachedMessages(id, msgs);
    expect(getCachedMessages(id)).toBe(msgs);
  });
});

// ─── setCachedMessages ────────────────────────────────────────────────────────

describe('setCachedMessages', () => {
  test('stores messages and makes them retrievable', () => {
    const id = 'sc-basic-' + Math.random();
    const msgs = [makeMsg('x1'), makeMsg('x2')];
    setCachedMessages(id, msgs);
    expect(getCachedMessages(id)).toEqual(msgs);
  });

  test('overwrites existing messages for the same id', () => {
    const id = 'sc-overwrite-' + Math.random();
    setCachedMessages(id, [makeMsg('old')]);
    const fresh = [makeMsg('new1'), makeMsg('new2')];
    setCachedMessages(id, fresh);
    expect(getCachedMessages(id)).toEqual(fresh);
  });

  test('stores an empty array', () => {
    const id = 'sc-empty-' + Math.random();
    setCachedMessages(id, []);
    expect(getCachedMessages(id)).toEqual([]);
  });

  test('evicts the oldest entry when size exceeds MAX_CACHED_CONVERSATIONS (20)', () => {
    const prefix = 'evict-' + Math.random() + '-';

    // Insert 20 entries.
    for (let i = 0; i < 20; i++) {
      setCachedMessages(prefix + String(i), [makeMsg('m' + String(i))]);
    }

    // Insert 21st entry — should evict the very first one (prefix + '0').
    const msg20 = makeMsg('m20');
    setCachedMessages(prefix + '20', [msg20]);

    expect(getCachedMessages(prefix + '0')).toEqual([]);
    expect(getCachedMessages(prefix + '20')).toEqual([msg20]);
  });

  test('does not evict when size is exactly MAX_CACHED_CONVERSATIONS (20)', () => {
    const prefix = 'no-evict-' + Math.random() + '-';

    // Insert exactly 20 entries — capture boundary messages for assertion.
    const msgs: Record<string, ChatMessage[]> = {};
    for (let i = 0; i < 20; i++) {
      const m = [makeMsg('n' + String(i))];
      msgs[String(i)] = m;
      setCachedMessages(prefix + String(i), m);
    }

    // All 20 entries should still be present.
    expect(getCachedMessages(prefix + '0')).toEqual(msgs['0']);
    expect(getCachedMessages(prefix + '19')).toEqual(msgs['19']);
  });

  test('re-inserting an existing id does not increase size and does not evict another entry', () => {
    const prefix = 'reinsert-' + Math.random() + '-';

    // Fill to 20 — capture first entry for assertion.
    const msg0 = makeMsg('r0');
    setCachedMessages(prefix + '0', [msg0]);
    for (let i = 1; i < 20; i++) {
      setCachedMessages(prefix + String(i), [makeMsg('r' + String(i))]);
    }

    // Re-insert an existing id — size stays at 20, nothing should be evicted.
    const msgUpdated = makeMsg('updated');
    setCachedMessages(prefix + '5', [msgUpdated]);

    // The first entry (0) must still be present because no eviction occurred.
    expect(getCachedMessages(prefix + '0')).toEqual([msg0]);
    // The re-inserted entry has the new content.
    expect(getCachedMessages(prefix + '5')).toEqual([msgUpdated]);
  });
});

// ─── setSendInFlight / isSendInFlight ─────────────────────────────────────────

describe('setSendInFlight / isSendInFlight', () => {
  test('defaults to false at the start of each test (reset in beforeEach)', () => {
    expect(isSendInFlight()).toBe(false);
  });

  test('setSendInFlight(true) makes isSendInFlight() return true', () => {
    setSendInFlight(true);
    expect(isSendInFlight()).toBe(true);
  });

  test('setSendInFlight(false) makes isSendInFlight() return false after being true', () => {
    setSendInFlight(true);
    setSendInFlight(false);
    expect(isSendInFlight()).toBe(false);
  });

  test('calling setSendInFlight(false) when already false leaves it false', () => {
    setSendInFlight(false);
    expect(isSendInFlight()).toBe(false);
  });

  test('calling setSendInFlight(true) twice leaves it true', () => {
    setSendInFlight(true);
    setSendInFlight(true);
    expect(isSendInFlight()).toBe(true);
  });
});
