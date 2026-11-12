import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@archon/paths';

// SQL adapters share their connection; file adapters share their canonical root.
type Source = object | string;
type Listener = (runIds: readonly string[]) => Promise<void>;
interface Hold {
  count: number;
  pending: boolean;
  unsafe: boolean;
}
interface Scope {
  closed: boolean;
  parent: Scope | undefined;
  pending: Map<Source, Set<string>>;
  holds: Set<Hold>;
  unsafe: boolean;
}
const sources = new WeakMap<object, () => Source>();
const listeners = new Map<Source, Set<Listener>>();
const holds = new Map<Source, Map<string, Hold>>();
const scopes = new AsyncLocalStorage<Scope | undefined>();

// Continuation admission can return before its execution settles. Its async work
// inherits the context, but a closed admission scope must not retain later releases.
function activeScope(scope: Scope | undefined): Scope | undefined {
  while (scope?.closed) scope = scope.parent;
  return scope;
}

export function bindRunSlotReleaseStore<T extends object>(store: T, source: () => Source): T {
  sources.set(store, source);
  return store;
}

function sourceOf(store: object): Source {
  return sources.get(store)?.() ?? store;
}

export function subscribeRunSlotRelease(store: object, listener: Listener): () => void {
  const source = sourceOf(store);
  const subscribers = listeners.get(source) ?? new Set<Listener>();
  subscribers.add(listener);
  listeners.set(source, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(source);
  };
}

function add(pending: Map<Source, Set<string>>, source: Source, runId: string): void {
  const ids = pending.get(source) ?? new Set<string>();
  ids.add(runId);
  pending.set(source, ids);
}

async function dispatch(source: Source, runIds: readonly string[]): Promise<void> {
  // Successor execution must not inherit the predecessor's cleanup scope.
  await scopes.run(undefined, async () => {
    for (const listener of listeners.get(source) ?? []) {
      try {
        await listener(runIds);
      } catch (err) {
        createLogger('run-slot-release').error({ err, runIds }, 'run_slot_release.dispatch_failed');
      }
    }
  });
}

async function deliver(source: Source, runIds: Iterable<string>): Promise<void> {
  const ready: string[] = [];
  for (const id of runIds) {
    const hold = holds.get(source)?.get(id);
    if (hold) hold.pending = true;
    else ready.push(id);
  }
  if (ready.length) await dispatch(source, ready);
}

/** Publish only after a won terminal write or pause-slot release has committed. */
export async function publishRunSlotRelease(source: Source, runId: string): Promise<void> {
  if (!listeners.has(source)) return;
  const scope = activeScope(scopes.getStore());
  if (scope) add(scope.pending, source, runId);
  else await deliver(source, [runId]);
}

/** A workflow failure is safe to drain; unconfirmed resource cleanup is not. */
export function deferRunSlotRelease(): void {
  for (let scope = activeScope(scopes.getStore()); scope; scope = activeScope(scope.parent)) {
    scope.unsafe = true;
    for (const hold of scope.holds) hold.unsafe = true;
  }
}

export async function withRunSlotReleaseScope<T>(body: () => Promise<T>): Promise<T> {
  const scope: Scope = {
    parent: activeScope(scopes.getStore()),
    closed: false,
    pending: new Map(),
    holds: new Set(),
    unsafe: false,
  };
  try {
    return await scopes.run(scope, body);
  } finally {
    scope.closed = true;
    const parent = activeScope(scope.parent);
    if (scope.unsafe || [...scope.holds].some(hold => hold.unsafe)) {
      if (scope.pending.size)
        createLogger('run-slot-release').warn(
          { runIds: [...scope.pending.values()].flatMap(ids => [...ids]) },
          'run_slot_release.deferred_for_cleanup'
        );
    } else if (parent) {
      for (const [source, ids] of scope.pending)
        for (const id of ids) add(parent.pending, source, id);
      for (const hold of scope.holds) parent.holds.add(hold);
    } else {
      for (const [source, ids] of scope.pending) await deliver(source, ids);
    }
  }
}

/** Hold delivery across execution or a live-owner lifetime, including concurrent cancellation. */
export function holdRunSlotRelease(store: object, runId: string): () => Promise<void> {
  const source = sourceOf(store);
  const runs = holds.get(source) ?? new Map<string, Hold>();
  const hold = runs.get(runId) ?? { count: 0, pending: false, unsafe: false };
  hold.count++;
  runs.set(runId, hold);
  holds.set(source, runs);
  activeScope(scopes.getStore())?.holds.add(hold);
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    if (--hold.count) return;
    runs.delete(runId);
    if (!runs.size) holds.delete(source);
    if (!hold.pending) return;
    if (hold.unsafe) {
      createLogger('run-slot-release').warn({ runId }, 'run_slot_release.deferred_for_cleanup');
      return;
    }
    // A closing owner may itself still be inside an operation's cleanup scope.
    const scope = activeScope(scopes.getStore());
    if (scope) add(scope.pending, source, runId);
    else await dispatch(source, [runId]);
  };
}
