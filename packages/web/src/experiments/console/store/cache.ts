/**
 * Reactive server-state cache. Map of keyed entities + subscription primitive.
 *
 * Contract:
 * - UI never writes directly — it calls skill verbs; server pushes truth
 *   back via SSE (lib/sse.ts) or refetch on miss.
 * - `useEntity(key, loader)` subscribes to a key. First subscriber triggers
 *   the loader; subsequent subscribers read from cache. After `invalidate()`
 *   or `refetch()`, any key with an active subscriber reloads automatically.
 * - `patch` and `set` are for the SSE dispatcher and skill-layer optimistic
 *   updates only.
 *
 * Deliberately minimal. No React Query, no Zustand.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';

type Listener = () => void;

const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<Listener>>();
const errors = new Map<string, Error>();
const inflight = new Map<string, Promise<unknown>>();
const loaders = new Map<string, () => Promise<unknown>>();
// Per-key change counter. `useEntity` snapshots THIS (not the cached value), so a
// subscriber re-renders on every mutation — including the error transition, where
// the value stays `undefined` and a value-identity snapshot would bail out and
// never surface `error` (e.g. a 401 panel would hang on "Loading…").
const versions = new Map<string, number>();

function notify(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  const subs = listeners.get(key);
  if (subs === undefined) return;
  for (const l of subs) l();
}

function ensureLoad(key: string): void {
  if (cache.has(key) || inflight.has(key)) return;
  const loader = loaders.get(key);
  if (loader === undefined) return;
  const p = loader()
    .then(v => {
      cache.set(key, v);
      errors.delete(key);
      notify(key);
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.set(key, err);
      notify(key);
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
}

export function get(key: string): unknown {
  return cache.get(key);
}

export function set(key: string, value: unknown): void {
  cache.set(key, value);
  errors.delete(key);
  notify(key);
}

export function patch(key: string, updater: (prev: unknown) => unknown): void {
  const next = updater(cache.get(key));
  cache.set(key, next);
  notify(key);
}

/**
 * Revalidate one key in place (stale-while-revalidate). Re-runs the loader and
 * swaps the value in on resolve WITHOUT clearing the cache first — so a
 * subscriber keeps seeing the previous value until fresh data lands, instead of
 * flashing to `undefined`/empty on every refresh. That flash, at SSE/poll
 * cadence, made live message updates flicker and never settle.
 *
 * If no subscriber is registered (no loader), drop the entry so the next mount
 * fetches fresh.
 */
function revalidate(key: string): void {
  const loader = loaders.get(key);
  if (loader === undefined) {
    cache.delete(key);
    errors.delete(key);
    return;
  }
  if (inflight.has(key)) return; // a revalidation is already in flight
  const p = loader()
    .then(v => {
      cache.set(key, v);
      errors.delete(key);
      notify(key);
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.set(key, err);
      notify(key); // surface the error; any stale value stays in cache
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
}

export function invalidate(keyPrefix: string): void {
  // Match by exact key OR by `${prefix}:` so callers can pass either a
  // concrete key (`run:abc`) or a prefix that fans out (`runs`).
  const matches = (key: string): boolean => key === keyPrefix || key.startsWith(`${keyPrefix}:`);

  // Walk both the data cache AND the errors map. An errored key lives only in
  // `errors`, so iterating `cache.keys()` alone would leave it permanently
  // stuck — the loader would never refetch and the UI would require a full
  // page reload to recover.
  const toRefresh = new Set<string>();
  for (const key of [...cache.keys()]) {
    if (matches(key)) toRefresh.add(key);
  }
  for (const key of [...errors.keys()]) {
    if (matches(key)) toRefresh.add(key);
  }
  for (const key of toRefresh) {
    revalidate(key);
  }
}

export function keysStartingWith(prefix: string): string[] {
  const out: string[] = [];
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) out.push(k);
  }
  return out;
}

export interface EntityView<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => void;
}

/**
 * Subscribe to a keyed entity. On first subscribe (or after `refetch`),
 * invokes `loader`. Updates propagate to all subscribers via `notify`.
 *
 * Uses `useSyncExternalStore` so React reads a consistent snapshot and commits
 * the latest value — the previous manual `useState(n => n + 1)` subscription
 * could commit a stale render (the store mutates outside React's knowledge), so
 * a refetched value would land in the cache but never appear on screen until a
 * remount. `notify` is the store's change signal; `getSnapshot` reads the per-key
 * version counter (see below) so error transitions re-render too.
 */
export function useEntity<T>(key: string, loader: () => Promise<T>): EntityView<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      let subs = listeners.get(key);
      if (subs === undefined) {
        subs = new Set();
        listeners.set(key, subs);
      }
      subs.add(onStoreChange);

      loaders.set(key, () => loaderRef.current());
      ensureLoad(key);

      return (): void => {
        const s = listeners.get(key);
        if (s === undefined) return;
        s.delete(onStoreChange);
        if (s.size === 0) {
          listeners.delete(key);
          loaders.delete(key);
        }
      };
    },
    [key]
  );

  // Snapshot the per-key version counter (a number bumped on every `notify`), not
  // the cached value: that way the component re-renders on the error transition too
  // — where `cache.get(key)` stays `undefined` and a value-identity snapshot would
  // bail out, leaving `error` unread. `data`/`error`/`loading` are read fresh from
  // the maps below on each (synchronous) render. They can briefly co-exist in
  // intermediate states — e.g. `loading` is still true when an error first lands
  // (`inflight` clears in a later `.finally`) — so consumers check `error` before
  // `loading`, as the panels do.
  useSyncExternalStore(
    subscribe,
    () => versions.get(key) ?? 0,
    () => versions.get(key) ?? 0
  );

  return {
    data: cache.get(key) as T | undefined,
    error: errors.get(key),
    loading: !cache.has(key) && inflight.has(key),
    refetch: (): void => {
      revalidate(key);
    },
  };
}
