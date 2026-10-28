import { runAttention, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type {
  AttentionNoticeData,
  AttentionNoticeKind,
} from '@archon/workflows/schemas/attention-notice';
import { undeliveredNoticeKey, type AttentionNoticeRecord } from '../db/workflow-events';

export interface AttentionNotice {
  run: WorkflowRun;
  kind: AttentionNoticeKind;
  destination: string;
  key: string;
  previous?: AttentionNoticeData;
}

interface AttentionNoticeInput {
  runs: readonly WorkflowRun[];
  terminalRuns: readonly WorkflowRun[];
  ledger: readonly AttentionNoticeRecord[];
  destinations: readonly string[];
  initialized: ReadonlySet<string>;
  conversationPlatforms: ReadonlyMap<string, string>;
  inlinePlatforms: ReadonlySet<string>;
  /** `undeliveredNoticeKey`s of pauses whose inline chat notice failed to post. */
  undeliveredNotices: ReadonlySet<string>;
}

export function selectAttentionNotices(input: AttentionNoticeInput): {
  pushes: AttentionNotice[];
  baselines: AttentionNoticeRecord[];
} {
  const pushes: AttentionNotice[] = [];
  const baselines: AttentionNoticeRecord[] = [];
  for (const destination of input.destinations) {
    const initialized = input.initialized.has(destination);
    for (const notice of input.runs.flatMap(run => pauseNotice(input, run, destination) ?? [])) {
      if (initialized) pushes.push(notice);
      else
        baselines.push({
          runId: notice.run.id,
          data: { destination, key: notice.key, baseline: true },
        });
    }
    pushes.push(
      ...input.terminalRuns.flatMap(run => terminalNotice(input.ledger, run, destination) ?? [])
    );
  }
  return { pushes, baselines };
}

/** The notice a paused run owes a destination that has not recorded its pause yet. */
function pauseNotice(
  input: AttentionNoticeInput,
  run: WorkflowRun,
  destination: string
): AttentionNotice | undefined {
  const attention = runAttention(run);
  if (attention?.kind !== 'awaiting_response' && attention?.kind !== 'attention') return undefined;
  if (toldInline(input, run.id, attention.occurrence)) return undefined;
  const nodeId =
    attention.kind === 'awaiting_response' ? attention.respondTo.nodeId : attention.nodeId;
  const key = `${nodeId}:${attention.occurrence}`;
  if (
    input.ledger.some(
      row => row.runId === run.id && row.data.destination === destination && row.data.key === key
    )
  )
    return undefined;
  return {
    run,
    kind: attention.kind === 'awaiting_response' ? 'gate' : 'attention',
    destination,
    key,
  };
}

// An inline platform tells its own users about a pause, so a push would duplicate it.
// When that notice failed, nobody was told, and the pause is pushed like any other.
function toldInline(input: AttentionNoticeInput, runId: string, occurrence: string): boolean {
  const platform = input.conversationPlatforms.get(runId);
  return (
    platform !== undefined &&
    input.inlinePlatforms.has(platform) &&
    !input.undeliveredNotices.has(undeliveredNoticeKey(runId, occurrence))
  );
}

/**
 * A finished run's terminal notice, owed to a destination once it was told about the run
 * (a baseline does not count) and has not recorded the terminal notice yet.
 */
function terminalNotice(
  ledger: readonly AttentionNoticeRecord[],
  run: WorkflowRun,
  destination: string
): AttentionNotice | undefined {
  const records = ledger.filter(
    row => row.runId === run.id && row.data.destination === destination
  );
  if (records.some(row => row.data.key === 'terminal')) return undefined;
  const previous = [...records].reverse().find(row => row.data.baseline !== true);
  if (previous === undefined) return undefined;
  return { run, kind: 'terminal', destination, key: 'terminal', previous: previous.data };
}
