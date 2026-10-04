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

export interface RunAttentionSource {
  /** The runs as they stand when watching starts. None of them alert. */
  listRuns(): Promise<readonly Run[]>;
  getRun(runId: string): Promise<Run>;
}

export interface RunAttentionHandlers {
  onAttention(run: Run): void;
  onError(error: Error): void;
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
  let seeded = false;
  let pumping = false;
  let stopped = false;

  // One fetch at a time, so responses for the same run cannot land out of order.
  // Changes reported before the seed lands wait for it: the seed is what tells a
  // replayed event about an already-paused run apart from a new pause.
  async function pump(): Promise<void> {
    if (pumping || !seeded) return;
    pumping = true;
    try {
      while (!stopped && dirty.size > 0) {
        const [runId] = dirty;
        dirty.delete(runId);
        let run: Run;
        try {
          run = await source.getRun(runId);
        } catch (e) {
          if (!stopped) handlers.onError(toError(e));
          continue;
        }
        if (stopped) return;
        const next = attentionState(run);
        const previous = known.get(runId);
        known.set(runId, next);
        if (next !== null && next !== previous) handlers.onAttention(run);
      }
    } finally {
      pumping = false;
    }
  }

  source.listRuns().then(
    runs => {
      if (stopped) return;
      for (const run of runs) known.set(run.id, attentionState(run));
      seeded = true;
      void pump();
    },
    (e: unknown) => {
      if (!stopped) handlers.onError(toError(e));
    }
  );

  return {
    runChanged(runId): void {
      if (stopped) return;
      dirty.add(runId);
      void pump();
    },
    stop(): void {
      stopped = true;
    },
  };
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
