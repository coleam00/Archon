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

export function selectAttentionNotices(input: {
  runs: readonly WorkflowRun[];
  terminalRuns: readonly WorkflowRun[];
  ledger: readonly AttentionNoticeRecord[];
  destinations: readonly string[];
  initialized: ReadonlySet<string>;
  conversationPlatforms: ReadonlyMap<string, string>;
  inlinePlatforms: ReadonlySet<string>;
  /** `undeliveredNoticeKey`s of pauses whose inline chat notice failed to post. */
  undeliveredNotices: ReadonlySet<string>;
}): { pushes: AttentionNotice[]; baselines: AttentionNoticeRecord[] } {
  const pushes: AttentionNotice[] = [];
  const baselines: AttentionNoticeRecord[] = [];
  for (const destination of input.destinations) {
    for (const run of input.runs) {
      const attention = runAttention(run);
      if (attention?.kind !== 'awaiting_response' && attention?.kind !== 'attention') continue;
      // An inline platform tells its own users about a pause, so a push would duplicate it.
      // When that notice failed, nobody was told, and the pause is pushed like any other.
      const platform = input.conversationPlatforms.get(run.id);
      if (
        platform !== undefined &&
        input.inlinePlatforms.has(platform) &&
        !input.undeliveredNotices.has(undeliveredNoticeKey(run.id, attention.occurrence))
      )
        continue;
      const nodeId =
        attention.kind === 'awaiting_response' ? attention.respondTo.nodeId : attention.nodeId;
      const key = `${nodeId}:${attention.occurrence}`;
      if (
        input.ledger.some(
          row =>
            row.runId === run.id && row.data.destination === destination && row.data.key === key
        )
      )
        continue;
      if (!input.initialized.has(destination)) {
        baselines.push({ runId: run.id, data: { destination, key, baseline: true } });
      } else {
        pushes.push({
          run,
          kind: attention.kind === 'awaiting_response' ? 'gate' : 'attention',
          destination,
          key,
        });
      }
    }
    for (const run of input.terminalRuns) {
      const records = input.ledger.filter(
        row => row.runId === run.id && row.data.destination === destination
      );
      if (records.some(row => row.data.key === 'terminal')) continue;
      const previous = [...records].reverse().find(row => row.data.baseline !== true);
      if (previous)
        pushes.push({
          run,
          kind: 'terminal',
          destination,
          key: 'terminal',
          previous: previous.data,
        });
    }
  }
  return { pushes, baselines };
}
