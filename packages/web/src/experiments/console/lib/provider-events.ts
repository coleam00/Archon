/**
 * A run's provider events (text, thinking, tool calls with output, subtasks, ...), as
 * the engine recorded them, held per node.
 *
 * A node's events are fetched once. After that, live `workflow_provider_event` frames
 * are appended as they arrive; nothing refetches the node. Each record is keyed by
 * `(attemptId, seq)`, and `seq` counts an attempt's events from 0, so a hole in an
 * attempt's sequence is a frame this page missed. A hole is closed with one cursor
 * fetch from the last contiguous event. The engine's store writes are not awaited, so
 * that fetch can run before the missing row is committed; the hole then stays open and
 * the next frame for the node retries it.
 */
import { useSyncExternalStore } from 'react';
import type { components } from '@/lib/api.generated';
import { requestJson } from './http';

export type ProviderEventRecord = components['schemas']['ProviderEventRecord'];
export type ProviderEvent = ProviderEventRecord['event'];

export interface ProviderEventCursor {
  attemptId: string;
  seq: number;
}

/** Fetch one node's records, all of them or those after a cursor. */
export type ProviderEventFetcher = (
  runId: string,
  stepName: string,
  after?: ProviderEventCursor
) => Promise<ProviderEventRecord[]>;

function recordKey(record: { attemptId: string | null; seq: number }): string {
  return JSON.stringify([record.attemptId, record.seq]);
}

/**
 * Merge records into a node's ordered list: duplicates dropped, attempts kept in the
 * order they were first seen, each attempt's events by `seq`.
 */
export function mergeProviderEventRecords(
  existing: readonly ProviderEventRecord[],
  incoming: readonly ProviderEventRecord[]
): ProviderEventRecord[] {
  const seen = new Set(existing.map(recordKey));
  const merged = [...existing];
  for (const record of incoming) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  const attemptRank = new Map<string | null, number>();
  for (const record of merged) {
    if (!attemptRank.has(record.attemptId)) attemptRank.set(record.attemptId, attemptRank.size);
  }
  return merged.sort(
    (a, b) =>
      (attemptRank.get(a.attemptId) ?? 0) - (attemptRank.get(b.attemptId) ?? 0) || a.seq - b.seq
  );
}

/**
 * Where to fetch from to close the first hole in a node's records: a cursor, `'all'`
 * when no earlier event can anchor one, or null when every attempt is contiguous from 0.
 * Legacy records (null attempt) are never live, so they never have a hole.
 */
export function findProviderEventGap(
  records: readonly ProviderEventRecord[]
): ProviderEventCursor | 'all' | null {
  let previous: ProviderEventCursor | undefined;
  let attemptId: string | null | undefined;
  let expected = 0;
  for (const record of records) {
    if (record.attemptId === null) continue;
    if (record.attemptId !== attemptId) {
      if (attemptId !== undefined && attemptId !== null) {
        previous = { attemptId, seq: expected - 1 };
      }
      attemptId = record.attemptId;
      expected = 0;
    }
    if (record.seq !== expected) {
      // Missing the attempt's start: the cursor after the previous attempt covers it.
      if (expected === 0) return previous ?? 'all';
      return { attemptId: record.attemptId, seq: expected - 1 };
    }
    expected += 1;
  }
  return null;
}

/** The cursor after everything a node holds, for catching up after a missed stretch. */
function lastCursor(records: readonly ProviderEventRecord[]): ProviderEventCursor | 'all' {
  for (const record of [...records].reverse()) {
    if (record.attemptId !== null) return { attemptId: record.attemptId, seq: record.seq };
  }
  return 'all';
}

interface StepState {
  records: ProviderEventRecord[];
  loaded: boolean;
  fetching: boolean;
}

/** One run's events by node, replaced (never mutated) on every change. */
export type RunProviderEvents = ReadonlyMap<string, readonly ProviderEventRecord[]>;

const EMPTY: RunProviderEvents = new Map();

export interface ProviderEventStore {
  /** Fetch a node's events unless it is already loaded or loading. */
  load(runId: string, stepName: string): void;
  /** Append one live frame. A frame for a node not yet loaded waits for its load. */
  receive(record: ProviderEventRecord): void;
  /** Fetch whatever a loaded node may have missed, e.g. after a reconnect. */
  catchUp(runId: string, stepName?: string): void;
  snapshot(runId: string): RunProviderEvents;
  subscribe(listener: () => void): () => void;
}

export function createProviderEventStore(fetcher: ProviderEventFetcher): ProviderEventStore {
  const runs = new Map<string, Map<string, StepState>>();
  const snapshots = new Map<string, RunProviderEvents>();
  const listeners = new Set<() => void>();

  const stepState = (runId: string, stepName: string): StepState => {
    let steps = runs.get(runId);
    if (steps === undefined) {
      steps = new Map();
      runs.set(runId, steps);
    }
    let state = steps.get(stepName);
    if (state === undefined) {
      state = { records: [], loaded: false, fetching: false };
      steps.set(stepName, state);
    }
    return state;
  };

  const publish = (runId: string): void => {
    const steps = runs.get(runId);
    snapshots.set(
      runId,
      new Map([...(steps ?? new Map<string, StepState>())].map(([step, s]) => [step, s.records]))
    );
    for (const listener of listeners) listener();
  };

  const fetchInto = (
    runId: string,
    stepName: string,
    from: ProviderEventCursor | 'all',
    onDone?: () => void
  ): void => {
    const state = stepState(runId, stepName);
    if (state.fetching) return;
    state.fetching = true;
    fetcher(runId, stepName, from === 'all' ? undefined : from)
      .then(records => {
        state.records = mergeProviderEventRecords(state.records, records);
        state.loaded = true;
        publish(runId);
      })
      .catch((err: unknown) => {
        // The next frame or reconnect retries; the node keeps what it already shows.
        console.warn('[console] provider events fetch failed', { runId, stepName, err });
      })
      .finally(() => {
        state.fetching = false;
        onDone?.();
      });
  };

  const closeGap = (runId: string, stepName: string): void => {
    const state = stepState(runId, stepName);
    if (!state.loaded || state.fetching) return;
    const gap = findProviderEventGap(state.records);
    if (gap !== null) fetchInto(runId, stepName, gap);
  };

  return {
    load(runId, stepName): void {
      const state = stepState(runId, stepName);
      if (state.loaded || state.fetching) return;
      // Frames that arrived while loading may sit past rows the load did not see yet.
      fetchInto(runId, stepName, 'all', () => {
        closeGap(runId, stepName);
      });
    },
    receive(record): void {
      const state = stepState(record.runId, record.stepName);
      const merged = mergeProviderEventRecords(state.records, [record]);
      if (merged.length === state.records.length) return; // duplicate
      state.records = merged;
      publish(record.runId);
      closeGap(record.runId, record.stepName);
    },
    catchUp(runId, stepName): void {
      const steps = runs.get(runId);
      if (steps === undefined) return;
      for (const [step, state] of steps) {
        if (stepName !== undefined && step !== stepName) continue;
        // From the first hole if there is one: everything after it comes back too.
        if (state.loaded) {
          fetchInto(runId, step, findProviderEventGap(state.records) ?? lastCursor(state.records));
        }
      }
    },
    snapshot(runId): RunProviderEvents {
      return snapshots.get(runId) ?? EMPTY;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

async function fetchProviderEvents(
  runId: string,
  stepName: string,
  after?: ProviderEventCursor
): Promise<ProviderEventRecord[]> {
  const qs = new URLSearchParams({ step: stepName });
  if (after !== undefined) {
    qs.set('attemptId', after.attemptId);
    qs.set('afterSeq', after.seq.toString());
  }
  const res = await requestJson<{ events: ProviderEventRecord[] }>(
    `/api/workflows/runs/${encodeURIComponent(runId)}/provider-events?${qs.toString()}`
  );
  return res.events;
}

/** The console's one store; the SSE wiring feeds it and run views read it. */
export const providerEventStore = createProviderEventStore(fetchProviderEvents);

/** A run's provider events by node, re-rendering on every change. */
export function useRunProviderEvents(runId: string | null): RunProviderEvents {
  return useSyncExternalStore(
    listener => providerEventStore.subscribe(listener),
    () => (runId === null ? EMPTY : providerEventStore.snapshot(runId)),
    () => EMPTY
  );
}
