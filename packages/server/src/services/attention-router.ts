import { createLogger } from '@archon/paths';
import type { IDatabase } from '@archon/core/db';
import { listRunsNeedingAttention, listNotifiedTerminalRuns } from '@archon/core/db/workflows';
import {
  attentionConversationPlatforms,
  insertWorkflowEvent,
  listAttentionNotices,
  listUndeliveredPauseNotices,
  persistWorkflowEvent,
} from '@archon/core/db/workflow-events';
import {
  selectAttentionNotices,
  type AttentionNotice,
} from '@archon/core/services/attention-notices';
import type { AttentionNoticeData } from '@archon/workflows/schemas/attention-notice';

export const PUSH_DESTINATION_STATES = [
  'active',
  'no_subscribers',
  'plugin_down',
  'misconfigured',
] as const;
export type PushDestinationState = (typeof PUSH_DESTINATION_STATES)[number];
export type PushDeliveryResult = Pick<AttentionNoticeData, 'conversationId'>;
export interface PushDestination {
  readonly id: string;
  state(): Promise<PushDestinationState>;
  deliver(notice: AttentionNotice, previous?: AttentionNoticeData): Promise<PushDeliveryResult>;
}

/**
 * Record every open pause as already noticed for `destination`, so activating it sends
 * nothing for runs that were waiting before. Runs inside the caller's transaction.
 */
export async function recordActivationBaseline(
  destination: string,
  inlinePlatforms: ReadonlySet<string>,
  query: IDatabase['query']
): Promise<void> {
  const runs = await listRunsNeedingAttention(query);
  const conversationPlatforms = await attentionConversationPlatforms(
    runs.map(run => run.id),
    query
  );
  const undeliveredNotices = await listUndeliveredPauseNotices(
    runs.map(run => run.id),
    query
  );
  const { baselines } = selectAttentionNotices({
    runs,
    terminalRuns: [],
    ledger: [],
    destinations: [destination],
    initialized: new Set(),
    conversationPlatforms,
    inlinePlatforms,
    undeliveredNotices,
  });
  for (const baseline of baselines)
    await insertWorkflowEvent(query, {
      workflow_run_id: baseline.runId,
      event_type: 'attention_notice_sent',
      data: baseline.data,
    });
}

export class AttentionRouter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = true;
  private readonly log = createLogger('server.attention-router');
  private readonly states = new Map<string, PushDestinationState>();

  constructor(
    private readonly destinations: readonly PushDestination[],
    private readonly inlinePlatforms: ReadonlySet<string>
  ) {}

  health(): { id: string; state: PushDestinationState }[] {
    return this.destinations.map(destination => ({
      id: destination.id,
      state: this.states.get(destination.id) ?? 'no_subscribers',
    }));
  }

  scan(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const active: PushDestination[] = [];
    for (const destination of this.destinations) {
      const state = await destination.state();
      this.states.set(destination.id, state);
      if (state === 'active') active.push(destination);
    }
    if (active.length === 0) return;
    const [runs, terminalRuns] = await Promise.all([
      listRunsNeedingAttention(),
      listNotifiedTerminalRuns(),
    ]);
    const runIds = [...runs, ...terminalRuns].map(run => run.id);
    const [ledger, conversationPlatforms, undeliveredNotices] = await Promise.all([
      listAttentionNotices(runIds),
      attentionConversationPlatforms(runs.map(run => run.id)),
      listUndeliveredPauseNotices(runs.map(run => run.id)),
    ]);
    // A destination registers only after its durable activation baseline has committed.
    const { pushes } = selectAttentionNotices({
      runs,
      terminalRuns,
      ledger,
      destinations: active.map(d => d.id),
      initialized: new Set(active.map(d => d.id)),
      conversationPlatforms,
      inlinePlatforms: this.inlinePlatforms,
      undeliveredNotices,
    });
    for (const notice of pushes) {
      const destination = active.find(d => d.id === notice.destination);
      if (!destination) continue;
      try {
        const result = await destination.deliver(notice, notice.previous);
        // Sending first permits a duplicate after a crash; recording first could lose the notice.
        await persistWorkflowEvent({
          workflow_run_id: notice.run.id,
          event_type: 'attention_notice_sent',
          data: {
            destination: destination.id,
            key: notice.key,
            conversationId: result.conversationId,
          },
        });
        this.log.info('attention.notice_sent');
      } catch (err) {
        this.log.error(
          { err, destination: destination.id, runId: notice.run.id },
          'attention.notice_failed'
        );
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      try {
        await this.scan();
      } catch (err) {
        this.log.error({ err }, 'attention.scan_failed');
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          void tick();
        }, 5000);
        this.timer.unref();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.scanning;
  }
}
