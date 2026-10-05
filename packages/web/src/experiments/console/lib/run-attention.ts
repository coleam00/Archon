/**
 * Detects the moment a run starts needing the operator — paused on a human gate,
 * or finished — so the console can alert once per transition (#1699).
 *
 * The dashboard stream only says "run X changed". Its payloads are not a reliable
 * transition log: the in-process emitter and the DB poller both deliver the same
 * transition, the poller can deliver a stale `running` after the emitter already
 * reported `failed`, and a fresh connection replays events buffered before the page
 * loaded. So the watcher treats an event as a cue to fetch the run, and compares
 * the authoritative state against the last state it saw for that run.
 */
import type { Run } from '../primitives/run';

type AttentionState = 'waiting' | 'completed' | 'failed' | 'cancelled';

type RunState = Pick<Run, 'status' | 'approval' | 'wait'>;

/**
 * A paused run needs a human only on an approval gate or an attention wait; a run
 * paused on an event or a scheduled time resumes on its own.
 */
function attentionState(run: RunState): AttentionState | null {
  switch (run.status) {
    case 'running':
      return null;
    case 'paused':
      return run.approval != null || run.wait?.kind === 'attention' ? 'waiting' : null;
    default:
      return run.status;
  }
}

export interface RunPage {
  runs: readonly Run[];
  /** How many runs exist in all pages together. */
  total: number;
}

export interface RunAttentionSource {
  /** One page of the runs as they stand, from `offset`. None of them alert. */
  listRuns(offset: number): Promise<RunPage>;
  getRun(runId: string): Promise<Run>;
}

export interface RunAttentionHandlers {
  onAttention(run: Run): void;
  /** Reading run state failed. The watcher retries on the next reported change. */
  onError(error: Error): void;
  /** A read succeeded after {@link onError}. */
  onRecovered(): void;
}

export interface RunAttentionWatcher {
  /** The live stream reported a change to this run. */
  runChanged(runId: string): void;
  stop(): void;
}

export function watchRunAttention(
  source: RunAttentionSource,
  handlers: RunAttentionHandlers
): RunAttentionWatcher {
  const known = new Map<string, AttentionState | null>();
  const dirty = new Set<string>();
  let seed: 'pending' | 'loading' | 'done' = 'pending';
  let failing = false;
  let pumping = false;
  let stopped = false;

  function failed(e: unknown): void {
    if (stopped) return;
    failing = true;
    handlers.onError(toError(e));
  }

  function succeeded(): void {
    if (!failing) return;
    failing = false;
    handlers.onRecovered();
  }

  // Every run that exists at load is seeded, however many pages that takes: an
  // unseeded run already waiting or finished would alert as new on its next event.
  async function loadSeed(): Promise<void> {
    seed = 'loading';
    const loaded = new Map<string, AttentionState | null>();
    try {
      let offset = 0;
      let page: RunPage;
      do {
        page = await source.listRuns(offset);
        if (stopped) return;
        for (const run of page.runs) loaded.set(run.id, attentionState(run));
        offset += page.runs.length;
      } while (page.runs.length > 0 && offset < page.total);
    } catch (e) {
      seed = 'pending';
      failed(e);
      return;
    }
    for (const [runId, state] of loaded) known.set(runId, state);
    seed = 'done';
    void pump();
  }

  // One fetch at a time, so responses for the same run cannot land out of order.
  // Changes reported before the seed lands wait for it: the seed is what tells a
  // replayed event about an already-paused run apart from a new pause.
  async function pump(): Promise<void> {
    if (pumping || seed !== 'done') return;
    pumping = true;
    const unread: string[] = [];
    try {
      while (!stopped && dirty.size > 0) {
        const [runId] = dirty;
        dirty.delete(runId);
        let run: Run;
        try {
          run = await source.getRun(runId);
        } catch (e) {
          unread.push(runId);
          failed(e);
          continue;
        }
        if (stopped) return;
        succeeded();
        const next = attentionState(run);
        const previous = known.get(runId);
        known.set(runId, next);
        if (next !== null && next !== previous) handlers.onAttention(run);
      }
    } finally {
      pumping = false;
      for (const runId of unread) dirty.add(runId);
    }
  }

  void loadSeed();

  return {
    runChanged(runId): void {
      if (stopped) return;
      dirty.add(runId);
      if (seed === 'pending') void loadSeed();
      else void pump();
    },
    stop(): void {
      stopped = true;
    },
  };
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
