import type { ChatAttentionNotice } from '@archon/chat-contract';
import { getDatabase } from '@archon/core/db/connection';
import { hasAnyAttentionNotice } from '@archon/core/db/workflow-events';
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import { attentionNoticeRouteId, type AttentionNoticeRoute } from '@archon/core/config';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import {
  isApprovalContext,
  isTerminalRunStatus,
  pausedAttentionWait,
  runAttention,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { AttentionNoticeData } from '@archon/workflows/schemas/attention-notice';
import { createLogger } from '@archon/paths';
import {
  recordActivationBaseline,
  type PushDeliveryResult,
  type PushDestination,
  type PushDestinationState,
} from '../services/attention-router';
import type { ChatPluginState, ChatSupervisor } from './supervisor';
import { runTotalCostUsd } from './run-events';

function gateNotice(run: WorkflowRun): ChatAttentionNotice {
  const attention = runAttention(run);
  const approval = run.metadata.approval;
  if (attention?.kind !== 'awaiting_response' || !isApprovalContext(approval))
    throw new Error(`Run ${run.id} is no longer paused at a gate`);
  const gateType = approval.type ?? 'approval';
  if (gateType === 'child_workflow' || gateType === 'fan_out')
    throw new Error(`Run ${run.id} is blocked on sub-runs, not a gate`);
  return {
    type: 'gate',
    runId: run.id,
    workflowName: run.workflow_name,
    nodeId: approval.nodeId,
    ...(approval.pauseId ? { pauseId: approval.pauseId } : {}),
    gateType,
    message: approval.message,
    decisions: getApprovalDecisions(approval),
  };
}

function waitNotice(run: WorkflowRun): ChatAttentionNotice {
  const attention = runAttention(run);
  if (attention?.kind !== 'attention')
    throw new Error(`Run ${run.id} is no longer paused at an attention wait`);
  const pauseId = pausedAttentionWait(run)?.pauseId;
  return {
    type: 'attention',
    runId: run.id,
    workflowName: run.workflow_name,
    nodeId: attention.nodeId,
    ...(pauseId ? { pauseId } : {}),
    message: attention.message,
    form: attention.form,
    options: attention.options,
  };
}

function terminalNotice(run: WorkflowRun): ChatAttentionNotice {
  if (!isTerminalRunStatus(run.status)) throw new Error(`Run ${run.id} has not finished`);
  const totalCostUsd = runTotalCostUsd(run);
  return {
    type: 'terminal',
    runId: run.id,
    workflowName: run.workflow_name,
    status: run.status,
    ...(run.outcome ? { authoredOutcome: run.outcome } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

/**
 * The chat projection of a selected notice. Selection already read `runAttention`; a run
 * that moved since then throws, so the router logs the failure and selects again next scan.
 */
export function chatAttentionNotice(notice: AttentionNotice): ChatAttentionNotice {
  switch (notice.kind) {
    case 'gate':
      return gateNotice(notice.run);
    case 'attention':
      return waitNotice(notice.run);
    case 'terminal':
      return terminalNotice(notice.run);
  }
}

/** One configured chat route. The host passes `destination` through and never parses it. */
export class ChatAttentionDestination implements PushDestination {
  readonly id: string;
  private readonly problem: 'plugin_not_installed' | 'capability_missing' | undefined;

  constructor(
    private readonly route: AttentionNoticeRoute,
    private readonly supervisor: ChatSupervisor | undefined,
    private readonly pluginState: () => ChatPluginState | undefined,
    private readonly inlinePlatforms: ReadonlySet<string>
  ) {
    this.id = attentionNoticeRouteId(route);
    this.problem = !supervisor
      ? 'plugin_not_installed'
      : supervisor.plugin.descriptor.capabilities.attentionNotices
        ? undefined
        : 'capability_missing';
    if (this.problem)
      createLogger('server.chat-attention').warn(
        { destination: this.id, reason: this.problem },
        'attention.route_misconfigured'
      );
  }

  /**
   * Record open pauses as already noticed until this route has its first ledger row, so
   * enabling a route sends nothing for runs that were waiting before. Must finish before
   * the router's first scan, which treats every active destination as baselined.
   */
  async activate(): Promise<void> {
    if (this.problem) return;
    await getDatabase().withTransaction(async query => {
      if (!(await hasAnyAttentionNotice(this.id, query)))
        await recordActivationBaseline(this.id, this.inlinePlatforms, query);
    });
  }

  async state(): Promise<PushDestinationState> {
    if (this.problem) return 'misconfigured';
    return this.pluginState() === 'live' ? 'active' : 'plugin_down';
  }

  async deliver(
    notice: AttentionNotice,
    previous?: AttentionNoticeData
  ): Promise<PushDeliveryResult> {
    const { supervisor } = this;
    if (!supervisor) throw new Error(`Chat route ${this.id} has no installed plugin`);
    const params = {
      destination: this.route.destination,
      ...(previous?.conversationId ? { conversationId: previous.conversationId } : {}),
      notice: chatAttentionNotice(notice),
    };
    return supervisor.request(chat => chat.attentionNotice(params));
  }
}
