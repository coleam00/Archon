import { useEffect } from 'react';
import type { components } from '@/lib/api.generated';
import { SSE_BASE_URL } from './http';
import { followWhilePageShown, type PageEvents } from './page-stream';
import * as skill from '../skills';
import type { AttentionQueue } from '../skills/runs';
import { invalidate, type EntityView } from '../store/cache';
import { K } from '../store/keys';
import { useFactoryRead } from '../factory/useFactoryRead';

type StreamLineType = components['schemas']['AttentionStreamLine']['type'];

/** The part of an EventSource the watch uses, so a test can hand in its own. */
export interface AttentionEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

/** Bursts (a run resolving several items) refetch once. */
const COALESCE_MS = 250;
const CLOSED = 2;

function lineType(data: string): StreamLineType | undefined {
  try {
    const parsed = JSON.parse(data) as { type?: StreamLineType };
    return parsed.type;
  } catch {
    return undefined;
  }
}

/**
 * Follow a project's attention stream and call `onChange` when its open set may have
 * changed. The list is refetched rather than rebuilt from the lines: the server's list is
 * the one reading of the queue, and the stream only says when to read it again.
 *
 * Every line but `bookmark` counts, the connect snapshot and `ready` included, so an item
 * that opened between the list fetch and the stream connecting is not missed. An `error`
 * line means the server ended the stream on a cursor it can no longer read; reconnecting
 * natively would resend that cursor, so a fresh stream starts instead. The stream closes
 * while the page is hidden (`followWhilePageShown`).
 */
export function watchAttentionStream(
  url: string,
  onChange: () => void,
  open: (url: string) => AttentionEventSource,
  page: PageEvents = window
): () => void {
  return followWhilePageShown(() => followAttentionStream(url, onChange, open), page);
}

/** One connection's life: its source, its pending refetch, and the fresh start an error line asks for. */
function followAttentionStream(
  url: string,
  onChange: () => void,
  open: (url: string) => AttentionEventSource
): () => void {
  let source: AttentionEventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, COALESCE_MS);
  };

  const connect = (): void => {
    const current = open(url);
    source = current;
    current.onmessage = (event): void => {
      const type = lineType(event.data);
      if (type === undefined || type === 'bookmark') return;
      if (type === 'error') {
        current.close();
        if (!stopped) connect();
        return;
      }
      schedule();
    };
    current.onerror = (): void => {
      // EventSource retries a dropped connection itself; only a closed one is final.
      if (current.readyState === CLOSED) console.warn('[console-sse] attention stream closed');
    };
  };

  connect();
  return (): void => {
    stopped = true;
    source?.close();
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * What an attention change refreshes: the project's queue, and its item reads (every page
 * and item key under `factory-items:<projectId>`, read with or without a factory view),
 * whose questions and answers an ask opening or closing changes too. The dashboard SSE
 * does not carry asks.
 */
export function refreshOnAttentionChange(projectId: string): void {
  invalidate(K.projectAttention(projectId));
  invalidate(K.factoryItems(projectId));
}

/**
 * A project's attention queue, kept live. Mounted once for every page of a project (by
 * `ProjectAttentionLayout`), so the Needs you tab's count, the Needs you page and the
 * Factory Overview share one fetch and one stream, which stays open across
 * the project's pages. The dashboard SSE's `invalidate('runs')` refreshes it too: the key
 * sits under `runs:`.
 */
export function useProjectAttentionRead(projectId: string): EntityView<AttentionQueue> {
  const key = K.projectAttention(projectId);
  const view = useFactoryRead<AttentionQueue>(key, within =>
    within(signal => skill.listAttentionQueue(projectId, { signal }))
  );
  useEffect(
    () =>
      watchAttentionStream(
        `${SSE_BASE_URL}/api/runs/attention/stream?project=${encodeURIComponent(projectId)}`,
        () => {
          refreshOnAttentionChange(projectId);
        },
        url => new EventSource(url)
      ),
    [projectId]
  );
  return view;
}
