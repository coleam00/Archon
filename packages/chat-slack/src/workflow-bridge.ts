import type { ChatContext, ChatRunEvent, RunActionResult } from '@archon/chat-contract';
import type { BlockButtonAction, ButtonAction } from '@slack/bolt';
import { descriptor } from './descriptor';
import {
  REACTION_FAILURE,
  REACTION_RUNNING,
  REACTION_SUCCESS,
  buildApprovalBlocks,
  buildApprovalResolutionBlocks,
  parseApprovalValue,
  buildClosedApprovalBlocks,
  buildStatusBlocks,
  type SlackApprovalAction,
  type NodeSnapshot,
  type NodeState,
  type RunSnapshot,
  type RunTerminalStatus,
} from './blocks';
import { SlackAdapter, splitConversationId, type SlackMessageRef } from './adapter';
import { logFailure } from './log';

interface ApprovalMessage {
  message: string;
  ts?: string;
}

interface RunState {
  runId: string;
  workflowName: string;
  conversationId: string;
  channel: string;
  threadTs?: string;
  statusMessageTs?: string;
  startedAt: number;
  status: 'running' | 'paused';
  approvalDeliveryFailed?: boolean;
  authoredOutcome?: RunSnapshot['authoredOutcome'];
  nodes: Map<string, NodeSnapshot>;
  pendingEdit?: ReturnType<typeof setTimeout>;
  approvals: Map<string, ApprovalMessage>;
}

const STATUS_UPDATE_DEBOUNCE_MS = 500;
const RESUME_NOT_ACCEPTED_NOTE =
  'recorded — resume was not accepted; check the run status and resume it manually if still paused';
const CAPACITY_WAIT_NOTE =
  'recorded — waiting for capacity; the run stays paused in its place and Archon continues it when its resource frees';

export class SlackWorkflowBridge {
  private readonly runs = new Map<string, RunState>();
  private rendering = Promise.resolve();
  private stopping = false;
  constructor(
    private readonly adapter: SlackAdapter,
    private readonly ctx: ChatContext
  ) {}

  attach(): void {
    this.registerActionHandlers();
  }

  async detach(): Promise<void> {
    this.stopping = true;
    for (const state of this.runs.values()) clearTimeout(state.pendingEdit);
    await this.rendering;
    this.runs.clear();
  }

  private enqueue(render: () => Promise<void>): Promise<void> {
    const rendering = this.rendering.then(render);
    this.rendering = rendering.catch(() => undefined);
    return rendering;
  }

  handleEvent(event: ChatRunEvent): Promise<void> {
    return this.enqueue(() => this.renderEvent(event));
  }

  private async renderEvent(event: ChatRunEvent): Promise<void> {
    switch (event.type) {
      case 'workflow_started': {
        const [channel, threadTs] = splitConversationId(event.conversationId);
        const state: RunState = {
          runId: event.runId,
          workflowName: event.workflowName,
          conversationId: event.conversationId,
          channel,
          threadTs,
          startedAt: Date.now(),
          status: 'running',
          nodes: new Map(),
          approvals: new Map(),
        };
        this.runs.set(event.runId, state);
        const trigger = this.adapter.getTriggeringMessage(event.conversationId);
        if (trigger) await this.addReactionSafe(trigger, REACTION_RUNNING);
        const { blocks, fallbackText } = buildStatusBlocks(this.snapshot(state));
        const result = await this.adapter.getApp().client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: fallbackText,
          blocks,
        });
        state.statusMessageTs = result.ts;
        return;
      }
      case 'node_state':
        if (event.state === 'running') {
          const state = this.runs.get(event.runId);
          if (state) {
            state.status = 'running';
            state.approvalDeliveryFailed = false;
          }
        }
        this.upsertNode(event.runId, event.nodeId, event.nodeName, event.state, event);
        this.scheduleStatusUpdate(event.runId);
        return;
      case 'approval_pending':
        await this.onApprovalPending(event);
        return;
      case 'terminal':
        await this.onTerminal(event);
        return;
    }
  }

  private async onTerminal(event: Extract<ChatRunEvent, { type: 'terminal' }>): Promise<void> {
    const state = this.runs.get(event.runId);
    if (!state) return;
    this.runs.delete(event.runId);
    clearTimeout(state.pendingEdit);
    state.pendingEdit = undefined;
    const closing = this.closeApprovals(state, event.status);
    const trigger = this.adapter.getTriggeringMessage(state.conversationId);
    if (trigger) {
      await this.removeReactionSafe(trigger, REACTION_RUNNING);
      const execution = event.status === 'completed' ? REACTION_SUCCESS : REACTION_FAILURE;
      await this.addReactionSafe(trigger, execution);
      const outcome =
        event.authoredOutcome === 'succeeded'
          ? REACTION_SUCCESS
          : event.authoredOutcome === 'failed'
            ? REACTION_FAILURE
            : undefined;
      if (outcome && outcome !== execution) await this.addReactionSafe(trigger, outcome);
    }
    await this.updateStatusMessage(state, {
      status: event.status,
      authoredOutcome: event.authoredOutcome,
      totalCostUsd: event.totalCostUsd,
      failureReason: event.error,
    });
    await closing;
    this.adapter.clearTriggeringMessage(state.conversationId);
  }

  private async onApprovalPending(
    event: Extract<ChatRunEvent, { type: 'approval_pending' }>
  ): Promise<void> {
    const state = this.runs.get(event.runId);
    if (!state) {
      logFailure('slack.bridge_approval_no_run', new Error('Slack rendering unavailable'));
      return;
    }
    state.status = 'paused';
    state.authoredOutcome = event.authoredOutcome;
    await this.updateStatusMessage(state);

    const { blocks, fallbackText } = buildApprovalBlocks({
      runId: event.runId,
      nodeId: event.nodeId,
      message: event.message,
      decisions: event.decisions,
      pauseId: event.pauseId,
    });
    const approval: ApprovalMessage = { message: event.message };
    state.approvals.set(event.nodeId, approval);
    try {
      const result = await this.adapter.getApp().client.chat.postMessage({
        channel: state.channel,
        thread_ts: state.threadTs,
        text: fallbackText,
        ...(blocks.length > 0 ? { blocks } : {}),
      });
      approval.ts = result.ts;
    } catch (err) {
      logFailure('slack.bridge_approval_post_failed', err);
      state.approvalDeliveryFailed = true;
      // With neither a card nor recovery text in Slack, only the operator can act on the
      // pause, so the log names the run for the Web UI or `archon workflow approve`.
      if (!(await this.updateStatusMessage(state)))
        logFailure('slack.bridge_approval_undelivered', err, event.runId);
    }
    if (!approval.ts && state.approvals.get(event.nodeId) === approval)
      state.approvals.delete(event.nodeId);
  }

  private async closeApprovals(state: RunState, terminalStatus: RunTerminalStatus): Promise<void> {
    const approvals = [...state.approvals.values()];
    state.approvals.clear();
    await Promise.all(
      approvals.map(async approval => {
        const ts = approval.ts;
        if (!ts) return;
        const { blocks, fallbackText } = buildClosedApprovalBlocks({
          runId: state.runId,
          terminalStatus,
          originalMessage: approval.message,
        });
        try {
          await this.adapter.getApp().client.chat.update({
            channel: state.channel,
            ts,
            text: fallbackText,
            blocks,
          });
        } catch (error) {
          logFailure('slack.bridge_approval_close_failed', error);
        }
      })
    );
  }

  private upsertNode(
    runId: string,
    nodeId: string,
    nodeName: string,
    state: NodeState,
    extra: { durationMs?: number; error?: string } = {}
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.nodes.set(nodeId, {
      nodeId,
      nodeName,
      state,
      durationMs:
        state === 'completed'
          ? (extra.durationMs ?? run.nodes.get(nodeId)?.durationMs)
          : extra.durationMs,
      error: extra.error,
    });
  }

  private scheduleStatusUpdate(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    if (this.stopping || state.pendingEdit) return;
    state.pendingEdit = setTimeout(() => {
      state.pendingEdit = undefined;
      // Timer writes share event ordering so an in-flight edit cannot overwrite a newer state.
      void this.enqueue(async () => {
        if (this.runs.get(runId) === state) await this.updateStatusMessage(state);
      }).catch(err => {
        logFailure('slack.bridge_status_update_failed', err);
      });
    }, STATUS_UPDATE_DEBOUNCE_MS);
  }

  private async updateStatusMessage(
    state: RunState,
    overlay: Partial<
      Pick<RunSnapshot, 'status' | 'authoredOutcome' | 'totalCostUsd' | 'failureReason'>
    > = {}
  ): Promise<boolean> {
    if (!state.statusMessageTs) return false;
    const snapshot: RunSnapshot = { ...this.snapshot(state), ...overlay };
    const { blocks, fallbackText } = buildStatusBlocks(snapshot);
    try {
      await this.adapter.getApp().client.chat.update({
        channel: state.channel,
        ts: state.statusMessageTs,
        text: fallbackText,
        blocks,
      });
      return true;
    } catch (error) {
      logFailure('slack.bridge_status_update_failed', error);
      return false;
    }
  }

  private snapshot(state: RunState): RunSnapshot {
    return {
      runId: state.runId,
      workflowName: state.workflowName,
      startedAt: state.startedAt,
      status: state.status,
      authoredOutcome: state.authoredOutcome,
      approvalDeliveryFailed: state.approvalDeliveryFailed,
      nodes: [...state.nodes.values()],
    };
  }

  private async addReactionSafe(ref: SlackMessageRef, name: string): Promise<void> {
    try {
      await this.adapter.getApp().client.reactions.add({
        channel: ref.channel,
        timestamp: ref.ts,
        name,
      });
    } catch (error) {
      logFailure('slack.bridge_reaction_add_failed', error);
    }
  }

  private async removeReactionSafe(ref: SlackMessageRef, name: string): Promise<void> {
    try {
      await this.adapter.getApp().client.reactions.remove({
        channel: ref.channel,
        timestamp: ref.ts,
        name,
      });
    } catch (error) {
      logFailure('slack.bridge_reaction_remove_failed', error);
    }
  }

  private registerActionHandlers(): void {
    const app = this.adapter.getApp();
    app.action<BlockButtonAction>(/^(approve|reject|respond):/, async ({ ack, body, action }) => {
      await ack();
      await this.handleApprovalDecision(body, action);
    });
    app.action<BlockButtonAction>(/^cancel:/, async ({ ack, body, action }) => {
      await ack();
      await this.handleCancelClick(body, action);
    });
  }

  private async handleApprovalDecision(
    body: BlockButtonAction,
    action: ButtonAction
  ): Promise<void> {
    const parsed = parseApprovalAction(action);
    if (!parsed) return;
    const { runId, nodeId, decision, pauseId } = parsed;
    try {
      const result = await this.ctx.runAction({
        action: 'respond',
        runId,
        sender: { platformUserId: body.user.id },
        response: { nodeId, decision, pauseId },
      });
      if (result.status === 'rejected') return;
      if (result.status === 'forbidden') {
        await this.postForbiddenAction(body, result.message);
        return;
      }
      if (result.status === 'refused') {
        await this.postActionNote(
          body,
          runId,
          `:warning: ${result.message}` + (result.abandonHint ? `\n${result.abandonHint}` : '')
        );
        return;
      }
      await this.applyResolutionEdit({
        runId,
        nodeId,
        decision,
        actorId: body.user.id,
        messageTs: body.message?.ts,
        channel: body.channel?.id,
        outcomeNote: resolutionNote(result.result),
      });
    } catch (err) {
      logFailure('action.respond', err);
      await this.postActionNote(
        body,
        runId,
        ':warning: Could not record the gate response. Check the current run status and server logs.'
      );
    }
  }

  private async postForbiddenAction(body: BlockButtonAction, text: string): Promise<void> {
    if (!body.channel?.id) return;
    await this.adapter
      .getApp()
      .client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text });
  }

  private async handleCancelClick(body: BlockButtonAction, action: ButtonAction): Promise<void> {
    const runId = action.action_id.slice('cancel:'.length);
    if (!runId) return;
    try {
      const response = await this.ctx.runAction({
        runId,
        action: 'cancel',
        sender: { platformUserId: body.user.id },
      });
      if (response.status === 'rejected') return;
      if (response.status === 'forbidden') {
        await this.postForbiddenAction(body, response.message);
        return;
      }
      if (response.status === 'refused') {
        await this.postActionNote(
          body,
          runId,
          `:warning: ${response.message}` +
            (response.abandonHint ? `\n${response.abandonHint}` : '')
        );
        return;
      }
      const result = response.result;
      if (result.kind === 'stopped') {
        await this.postStoppedCancelNote(body, runId, result);
      } else if (result.kind === 'cooperative') {
        await this.postCooperativeCancelNote(body, runId, result);
      }
    } catch (err) {
      logFailure('action.cancel', err);
      await this.postActionNote(
        body,
        runId,
        `:warning: Could not cancel run \`${runId}\`. Check the server logs or try again.`
      );
    }
  }

  private async postStoppedCancelNote(
    body: BlockButtonAction,
    runId: string,
    result: Extract<RunActionResult, { kind: 'stopped' }>
  ): Promise<void> {
    let note = `Stopped the run's live owner process (pid ${String(result.pid)}), then cancelled the run.`;
    for (const warning of result.cleanupWarnings ?? []) note += `\n:warning: ${warning}`;
    if (result.cascadeFailures > 0)
      note += `\n:warning: ${String(result.cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check \`${descriptor.workflowCommand.prefix}status\`.`;
    if (result.blockedParentRunId)
      note += `\n:warning: Parent run \`${result.blockedParentRunId}\` was blocked on this sub-run and stays paused. Resume it so it reads this sub-run's outcome, or abandon it too.`;
    await this.postActionNote(body, runId, note);
  }

  private async postCooperativeCancelNote(
    body: BlockButtonAction,
    runId: string,
    result: Extract<RunActionResult, { kind: 'cooperative' }>
  ): Promise<void> {
    const note = result.cancelled
      ? (result.cleanupWarnings ?? []).map(warning => `:warning: ${warning}`).join('\n')
      : `:information_source: Run \`${runId}\` already finished — nothing to cancel.`;
    if (note) await this.postActionNote(body, runId, note);
  }

  private async postActionNote(
    body: BlockButtonAction,
    runId: string,
    text: string
  ): Promise<void> {
    const state = this.runs.get(runId);
    const fallbackChannel = body.channel?.id;
    const fallbackThreadTs = body.message?.ts;
    const target = state
      ? { channel: state.channel, thread_ts: state.threadTs }
      : fallbackChannel
        ? { channel: fallbackChannel, thread_ts: fallbackThreadTs }
        : undefined;

    if (!target) {
      logFailure('slack.bridge_action_no_target', new Error('Slack rendering unavailable'));
      return;
    }

    try {
      await this.adapter.getApp().client.chat.postMessage({
        channel: target.channel,
        thread_ts: target.thread_ts,
        text,
      });
    } catch (notifyError) {
      logFailure('slack.bridge_action_notify_failed', notifyError);
    }
  }

  private async applyResolutionEdit(args: {
    runId: string;
    nodeId: string;
    decision: string;
    actorId: string;
    messageTs?: string;
    channel?: string;
    outcomeNote?: string;
  }): Promise<void> {
    if (!args.messageTs || !args.channel) return;
    const state = this.runs.get(args.runId);
    const approval = state?.approvals.get(args.nodeId);
    const originalMessage = approval?.message ?? '(approval gate)';
    if (state) {
      state.approvals.delete(args.nodeId);
    }
    const { blocks, fallbackText } = buildApprovalResolutionBlocks({
      runId: args.runId,
      nodeId: args.nodeId,
      decision: args.decision,
      actorUserId: args.actorId,
      originalMessage,
      outcomeNote: args.outcomeNote,
    });
    try {
      await this.adapter.getApp().client.chat.update({
        channel: args.channel,
        ts: args.messageTs,
        text: fallbackText,
        blocks,
      });
    } catch (error) {
      logFailure('slack.bridge_resolution_update_failed', error);
    }
  }
}

function parseApprovalAction(action: ButtonAction): SlackApprovalAction | undefined {
  if (action.value !== undefined) return parseApprovalValue(action.value);
  const [prefix, runId, ...path] = action.action_id.split(':');
  if (!runId) return undefined;
  const decision = prefix === 'respond' ? path.pop() : prefix;
  if (!decision || !['respond', 'approve', 'reject'].includes(prefix ?? '')) return undefined;
  const nodeId = path.join(':');
  return nodeId ? { runId, nodeId, decision } : undefined;
}

function notResumedNote(result: { waitingForCapacity?: true }): string {
  return result.waitingForCapacity ? CAPACITY_WAIT_NOTE : RESUME_NOT_ACCEPTED_NOTE;
}

function rejectionNote(result: Extract<RunActionResult, { kind: 'rejected' }>): string {
  if (result.cancelled)
    return [
      result.maxAttemptsReached ? 'cancelled — max reject attempts reached' : 'cancelled',
      ...(result.cleanupWarnings ?? []).map(warning => `warning: ${warning}`),
    ].join(' — ');
  if (!result.resumed) return notResumedNote(result);
  if (result.writeBack) return 'recorded — workflow resumed to discard the container changes';
  return result.newMode
    ? 'recorded — workflow resumed'
    : 'recorded — workflow resumed and will retry with feedback';
}

export function resolutionNote(result: RunActionResult): string | undefined {
  switch (result.kind) {
    case 'approved':
      return !result.resumed
        ? notResumedNote(result)
        : result.type === 'interactive_loop'
          ? 'workflow resumed — finalizes if the gate paused after a completion condition was met, otherwise the loop runs another iteration'
          : 'workflow resumed';
    case 'rejected':
      return rejectionNote(result);
    case 'answered':
    case 'resumed':
      return result.resumed ? 'workflow resumed' : notResumedNote(result);
    case 'cooperative':
    case 'stopped':
      return undefined;
  }
}
