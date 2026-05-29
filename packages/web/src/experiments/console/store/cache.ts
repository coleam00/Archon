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
 * Deliberately minimal: ~120 LOC. No React Query, no Zustand.
 */

import { useEffect, useRef, useState } from 'react';

type Listener = () => void;

const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<Listener>>();
const errors = new Map<string, Error>();
const inflight = new Map<string, Promise<unknown>>();
const loaders = new Map<string, () => Promise<unknown>>();

function notify(key: string): void {
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
    cache.delete(key);
    errors.delete(key);
    notify(key);
    ensureLoad(key);
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
 */
export function useEntity<T>(key: string, loader: () => Promise<T>): EntityView<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [, rerender] = useState(0);

  useEffect(() => {
    let active = true;

    let subs = listeners.get(key);
    if (subs === undefined) {
      subs = new Set();
      listeners.set(key, subs);
    }
    const listener: Listener = () => {
      if (active) rerender(n => n + 1);
    };
    subs.add(listener);

    loaders.set(key, () => loaderRef.current());
    ensureLoad(key);

    return (): void => {
      active = false;
      subs.delete(listener);
      if (subs.size === 0) {
        listeners.delete(key);
        loaders.delete(key);
      }
    };
  }, [key]);

  return {
    data: cache.get(key) as T | undefined,
    error: errors.get(key),
    loading: !cache.has(key) && inflight.has(key),
    refetch: (): void => {
      cache.delete(key);
      errors.delete(key);
      notify(key);
      ensureLoad(key);
    },
  };
}
