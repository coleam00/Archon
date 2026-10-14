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
 * - After the last unsubscribe, `cache`/`errors` are deliberately retained so
 *   a remount reads warm; only the per-key version counter is released.
 *   `invalidate()` fully releases subscriber-less keys.
 * - A resubscribe that arrives while a previous, abandoned load for the key is
 *   still in flight starts its OWN loader; the orphaned load can no longer
 *   clobber the fresh result (per-key `latestLoad` guard, #2101).
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
const pendingRevalidation = new Set<string>();
// Per-key change counter. `useEntity` snapshots THIS (not the cached value), so a
// subscriber re-renders on every mutation — including the error transition, where
// the value stays `undefined` and a value-identity snapshot would bail out and
// never surface `error` (e.g. a 401 panel would hang on "Loading…").
const versions = new Map<string, number>();
// Retained across unsubscribe to allow warm settles; invalidate releases it
// together with cache/errors so abandoned loads cannot resurrect a purged key.
const latestLoad = new Map<string, symbol>();

function notify(key: string): void {
  // No subscribers ⇒ nothing snapshots the counter, so don't bump it — a late
  // write (an in-flight load settling after the last unsubscribe, or an SSE
  // push for an unwatched key) would otherwise resurrect the `versions` entry
  // that unsubscribe just released (#1933). Cache/error writes still happen at
  // the call sites so a future remount reads warm.
  const subs = listeners.get(key);
  if (subs === undefined) return;
  versions.set(key, versionOf(key) + 1);
  for (const l of subs) l();
}

function runLoad(key: string, loader: () => Promise<unknown>): void {
  const token = Symbol();
  latestLoad.set(key, token);
  const p = loader()
    .then(v => {
      if (latestLoad.get(key) !== token) return; // superseded by a newer load for this key
      cache.set(key, v);
      errors.delete(key);
      notify(key);
    })
    .catch((e: unknown) => {
      if (latestLoad.get(key) !== token) return; // superseded — don't surface a stale error
      const err = e instanceof Error ? e : new Error(String(e));
      errors.set(key, err);
      notify(key); // surface the error; any stale value stays in cache
    })
    .finally(() => {
      // Only clear the entry if it's still THIS load's promise — a newer load
      // for the key may already own `inflight[key]`.
      if (inflight.get(key) === p) {
        inflight.delete(key);
        if (pendingRevalidation.delete(key)) revalidate(key);
      }
    });
  inflight.set(key, p);
}

function ensureLoad(key: string): void {
  if (cache.has(key) || inflight.has(key)) return;
  const loader = loaders.get(key);
  if (loader === undefined) return;
  runLoad(key, loader);
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
    versions.delete(key); // fully release the key — nothing subscribes, so nothing snapshots it
    latestLoad.delete(key);
    return;
  }
  if (inflight.has(key)) {
    pendingRevalidation.add(key);
    return;
  }
  runLoad(key, loader);
}

export function invalidate(keyPrefix: string): void {
  // Match by exact key OR by `${prefix}:` so callers can pass either a
  // concrete key (`run:abc`) or a prefix that fans out (`runs`).
  const matches = (key: string): boolean => key === keyPrefix || key.startsWith(`${keyPrefix}:`);

  // Subscribed keys may still be loading their first value, or hold only an error.
  const toRefresh = new Set<string>();
  for (const key of [...cache.keys()]) {
    if (matches(key)) toRefresh.add(key);
  }
  for (const key of [...errors.keys()]) {
    if (matches(key)) toRefresh.add(key);
  }
  for (const key of loaders.keys()) {
    if (matches(key)) toRefresh.add(key);
  }
  // A cold load abandoned by its last subscriber leaves only its token behind.
  for (const key of latestLoad.keys()) {
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

/**
 * Module-level subscription primitive backing `useEntity`. A plain function
 * (not a hook) so the subscribe/unsubscribe lifecycle is unit-testable — the
 * same extraction shape as `handleBuilderKeydown` in `useBuilderKeyboard`.
 *
 * Exported for tests; production code subscribes via `useEntity`, whose
 * `useSyncExternalStore` wiring guarantees the returned cleanup runs.
 */
export function subscribeKey(
  key: string,
  onStoreChange: Listener,
  loader: () => Promise<unknown>
): () => void {
  let subs = listeners.get(key);
  if (subs === undefined) {
    subs = new Set();
    listeners.set(key, subs);
  }
  subs.add(onStoreChange);

  loaders.set(key, loader);
  ensureLoad(key);

  return (): void => {
    const remainingSubs = listeners.get(key);
    if (remainingSubs === undefined) return;
    remainingSubs.delete(onStoreChange);
    if (remainingSubs.size === 0) {
      listeners.delete(key);
      loaders.delete(key);
      // Drop the change counter too — with no subscribers nothing snapshots it,
      // and `useSyncExternalStore` only compares snapshots for change, so a
      // remount starting back at 0 behaves identically. Without this the
      // `versions` Map grows unbounded across every key a session ever touches
      // (#1933); `notify` refuses to bump subscriber-less keys, so a load still
      // in flight here cannot resurrect the entry. `cache` and `errors` are
      // deliberately retained so a remount reads warm (see the module contract
      // above); `invalidate()` releases them for subscriber-less keys via
      // `revalidate`'s no-loader branch.
      versions.delete(key);
      // Detach any in-flight load. Promises aren't cancellable, so it keeps
      // running and may still warm the cache for a future remount (guarded by
      // its `latestLoad` token), but dropping it from `inflight` here means a resubscribe
      // arriving before it settles runs its OWN loader via `ensureLoad` instead
      // of inheriting this abandoned request's eventual result (#2101).
      inflight.delete(key);
      pendingRevalidation.delete(key);
    }
  };
}

/** Snapshot of the per-key change counter — `useEntity`'s store snapshot. */
export function versionOf(key: string): number {
  return versions.get(key) ?? 0;
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
    (onStoreChange: () => void): (() => void) =>
      subscribeKey(key, onStoreChange, () => loaderRef.current()),
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
    () => versionOf(key),
    () => versionOf(key)
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
