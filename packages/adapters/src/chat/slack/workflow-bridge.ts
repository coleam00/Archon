/**
 * Slack workflow bridge: translates WorkflowEventEmitter events into Slack
 * side-effects (reactions on the triggering message, in-thread status
 * messages with DAG progress, interactive approval/reject/cancel buttons).
 *
 * Modelled on packages/server/src/adapters/web/workflow-bridge.ts but emits
 * Slack chat.postMessage / chat.update / reactions.add calls instead of SSE.
 *
 * Lifecycle: instantiate after the SlackAdapter, call attach() BEFORE
 * SlackAdapter.start() so app.action handlers register before app.start()
 * fires the Socket Mode connection. Call detach() on shutdown.
 */
import type { BlockButtonAction, ButtonAction } from '@slack/bolt';
import { createLogger } from '@archon/paths';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import { workflowOperations, workflowDb } from '@archon/core';
import {
  REACTION_FAILURE,
  REACTION_RUNNING,
  REACTION_SUCCESS,
  buildApprovalBlocks,
  buildApprovalResolutionBlocks,
  buildStatusBlocks,
  type NodeSnapshot,
  type NodeState,
  type RunSnapshot,
  type RunTerminalState,
} from './blocks';
import { isSlackUserAuthorized } from './auth';
import type { SlackAdapter, SlackMessageRef } from './adapter';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.slack.bridge');
  return cachedLog;
}

interface ApprovalMessage {
  channel: string;
  ts: string;
  /** Original message text we showed alongside the buttons; reused in the resolution edit. */
  message: string;
  nodeId: string;
}

interface RunState {
  runId: string;
  workflowName: string;
  conversationId: string;
  channel: string;
  threadTs: string;
  /** ts of the bot's status message in the thread; used by chat.update. */
  statusMessageTs?: string;
  startedAt: number;
  nodes: Map<string, NodeSnapshot>;
  /** Insertion order — preserved so the status message renders nodes in arrival order. */
  nodeOrder: string[];
  /** Leading-edge debounce timer for chat.update: the first event in a burst
   *  arms the timer; subsequent events arriving before it fires are coalesced
   *  because the timer reads the current run state at fire time. */
  pendingEdit?: ReturnType<typeof setTimeout>;
  /** Active approval block in this run, keyed by nodeId. */
  approvals: Map<string, ApprovalMessage>;
}

/**
 * Coalesce window for chat.update on the run status message. Slack's
 * chat.update rate limit is roughly one call per channel per second, so
 * 500ms keeps the worst-case rate under that while still feeling live for
 * DAGs where node transitions span seconds.
 */
const STATUS_UPDATE_DEBOUNCE_MS = 500;

export class SlackWorkflowBridge {
  private adapter: SlackAdapter;
  private runs = new Map<string, RunState>();
  private unsubscribeEvents: (() => void) | null = null;
  private actionHandlersRegistered = false;

  constructor(adapter: SlackAdapter) {
    this.adapter = adapter;
  }

  /**
   * Register app.action handlers on the Bolt app and start listening for
   * workflow events. Must be called before SlackAdapter.start().
   */
  attach(): void {
    this.registerActionHandlers();
    const emitter = getWorkflowEventEmitter();
    this.unsubscribeEvents = emitter.subscribe(event => {
      void this.handleEvent(event);
    });
    getLog().info('slack.bridge_attached');
  }

  /** Detach event subscription. Slack app handlers cannot be deregistered. */
  detach(): void {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = null;
    }
    for (const state of this.runs.values()) {
      if (state.pendingEdit) clearTimeout(state.pendingEdit);
    }
    this.runs.clear();
    getLog().info('slack.bridge_detached');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handling
  // ─────────────────────────────────────────────────────────────────────────

  private async handleEvent(event: WorkflowEmitterEvent): Promise<void> {
    const emitter = getWorkflowEventEmitter();
    const conversationId = emitter.getConversationId(event.runId);
    if (!conversationId) return;

    // Skip if this conversation isn't one we have a Slack trigger for. This is
    // how we filter Slack conversations from web/Telegram/etc. — the adapter
    // populates `triggeringMessages` on inbound mention/DM/slash.
    const trigger = this.adapter.getTriggeringMessage(conversationId);
    if (!trigger) return;

    try {
      switch (event.type) {
        case 'workflow_started':
          await this.onWorkflowStarted(event, conversationId, trigger);
          break;
        case 'node_started':
          this.upsertNode(event.runId, event.nodeId, event.nodeName, 'running');
          this.scheduleStatusUpdate(event.runId);
          break;
        case 'node_completed':
          this.upsertNode(event.runId, event.nodeId, event.nodeName, 'completed', {
            durationMs: event.duration,
          });
          this.scheduleStatusUpdate(event.runId);
          break;
        case 'node_failed':
          this.upsertNode(event.runId, event.nodeId, event.nodeName, 'failed', {
            error: event.error,
          });
          this.scheduleStatusUpdate(event.runId);
          break;
        case 'node_skipped':
          this.upsertNode(event.runId, event.nodeId, event.nodeName, 'skipped');
          this.scheduleStatusUpdate(event.runId);
          break;
        case 'approval_pending':
          await this.onApprovalPending(event);
          break;
        case 'workflow_completed':
          await this.onTerminal(event.runId, 'completed', conversationId);
          break;
        case 'workflow_failed':
          await this.onTerminal(event.runId, 'failed', conversationId, event.error);
          break;
        case 'workflow_cancelled':
          await this.onTerminal(event.runId, 'cancelled', conversationId, event.reason);
          break;
        // Loop / tool / artifact events would surface as noise in-thread and
        // aren't tied to a button or actionable state; the status message
        // already conveys whether the run is healthy via the DAG node states.
        case 'loop_iteration_started':
        case 'loop_iteration_completed':
        case 'loop_iteration_failed':
        case 'tool_started':
        case 'tool_completed':
        case 'workflow_artifact':
          break;
        default: {
          const exhaustive: never = event;
          getLog().warn(
            { type: (exhaustive as { type: string }).type },
            'slack.bridge_unhandled_event'
          );
        }
      }
    } catch (error) {
      getLog().error(
        { err: error as Error, eventType: event.type, runId: event.runId },
        'slack.bridge_event_handler_failed'
      );
    }
  }

  private async onWorkflowStarted(
    event: WorkflowEmitterEvent & { type: 'workflow_started' },
    conversationId: string,
    trigger: SlackMessageRef
  ): Promise<void> {
    const [channel, threadTs] = splitConversationId(conversationId);
    if (!threadTs) {
      getLog().warn({ conversationId }, 'slack.bridge_no_thread_ts');
      return;
    }
    const state: RunState = {
      runId: event.runId,
      workflowName: event.workflowName,
      conversationId,
      channel,
      threadTs,
      startedAt: Date.now(),
      nodes: new Map(),
      nodeOrder: [],
      approvals: new Map(),
    };
    this.runs.set(event.runId, state);

    await this.addReactionSafe(trigger, REACTION_RUNNING);

    const { blocks, fallbackText } = buildStatusBlocks(this.snapshot(state));
    try {
      const result = await this.adapter.getApp().client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: fallbackText,
        blocks,
      });
      state.statusMessageTs = result.ts ?? undefined;
    } catch (error) {
      getLog().warn(
        { err: error as Error, runId: event.runId, channel },
        'slack.bridge_status_post_failed'
      );
    }
  }

  private async onApprovalPending(
    event: WorkflowEmitterEvent & { type: 'approval_pending' }
  ): Promise<void> {
    const state = this.runs.get(event.runId);
    if (!state) {
      getLog().warn({ runId: event.runId }, 'slack.bridge_approval_no_run');
      return;
    }
    const { blocks, fallbackText } = buildApprovalBlocks({
      runId: event.runId,
      nodeId: event.nodeId,
      message: event.message,
    });
    try {
      const result = await this.adapter.getApp().client.chat.postMessage({
        channel: state.channel,
        thread_ts: state.threadTs,
        text: fallbackText,
        blocks,
      });
      if (result.ts) {
        state.approvals.set(event.nodeId, {
          channel: state.channel,
          ts: result.ts,
          message: event.message,
          nodeId: event.nodeId,
        });
      }
    } catch (error) {
      getLog().warn(
        { err: error as Error, runId: event.runId, nodeId: event.nodeId },
        'slack.bridge_approval_post_failed'
      );
    }
  }

  private async onTerminal(
    runId: string,
    terminal: RunTerminalState,
    conversationId: string,
    reason?: string
  ): Promise<void> {
    const state = this.runs.get(runId);
    const trigger = this.adapter.getTriggeringMessage(conversationId);

    // Replace running reaction with the terminal one.
    if (trigger) {
      await this.removeReactionSafe(trigger, REACTION_RUNNING);
      await this.addReactionSafe(
        trigger,
        terminal === 'completed' ? REACTION_SUCCESS : REACTION_FAILURE
      );
    }

    if (state) {
      // Cancel any pending debounce.
      if (state.pendingEdit) {
        clearTimeout(state.pendingEdit);
        state.pendingEdit = undefined;
      }

      // Pull final cost from the workflow run record (best-effort).
      let totalCostUsd: number | undefined;
      try {
        const run = await workflowDb.getWorkflowRun(runId);
        const raw = run?.metadata?.total_cost_usd;
        if (typeof raw === 'number' && Number.isFinite(raw)) totalCostUsd = raw;
      } catch (error) {
        getLog().debug({ err: error as Error, runId }, 'slack.bridge_cost_lookup_failed');
      }

      await this.updateStatusMessage(state, {
        terminal,
        totalCostUsd,
        failureReason: terminal === 'completed' ? undefined : reason,
      });

      this.runs.delete(runId);
    }

    // Triggering message is no longer needed for this conversation once the
    // run has terminated. (Reactions stay — we only clear the map entry.)
    this.adapter.clearTriggeringMessage(conversationId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status-message update plumbing
  // ─────────────────────────────────────────────────────────────────────────

  private upsertNode(
    runId: string,
    nodeId: string,
    nodeName: string,
    state: NodeState,
    extra: { durationMs?: number; error?: string } = {}
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (!run.nodes.has(nodeId)) {
      run.nodeOrder.push(nodeId);
    }
    run.nodes.set(nodeId, {
      nodeId,
      nodeName,
      state,
      durationMs: extra.durationMs,
      error: extra.error,
    });
  }

  private scheduleStatusUpdate(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    // Leading-edge: the first event in a burst arms the timer; later events
    // are dropped because the timer reads current state when it fires.
    if (state.pendingEdit) return;
    state.pendingEdit = setTimeout(() => {
      state.pendingEdit = undefined;
      void this.updateStatusMessage(state);
    }, STATUS_UPDATE_DEBOUNCE_MS);
  }

  private async updateStatusMessage(
    state: RunState,
    overlay: Partial<Pick<RunSnapshot, 'terminal' | 'totalCostUsd' | 'failureReason'>> = {}
  ): Promise<void> {
    if (!state.statusMessageTs) return;
    const snapshot: RunSnapshot = { ...this.snapshot(state), ...overlay };
    const { blocks, fallbackText } = buildStatusBlocks(snapshot);
    try {
      await this.adapter.getApp().client.chat.update({
        channel: state.channel,
        ts: state.statusMessageTs,
        text: fallbackText,
        blocks,
      });
    } catch (error) {
      getLog().warn(
        { err: error as Error, runId: state.runId, ts: state.statusMessageTs },
        'slack.bridge_status_update_failed'
      );
    }
  }

  private snapshot(state: RunState): RunSnapshot {
    return {
      runId: state.runId,
      workflowName: state.workflowName,
      startedAt: state.startedAt,
      nodes: state.nodeOrder.map(id => state.nodes.get(id)).filter(isDefined),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reactions
  // ─────────────────────────────────────────────────────────────────────────

  private async addReactionSafe(ref: SlackMessageRef, name: string): Promise<void> {
    try {
      await this.adapter.getApp().client.reactions.add({
        channel: ref.channel,
        timestamp: ref.ts,
        name,
      });
    } catch (error) {
      // `already_reacted` and rate limits are non-fatal — just log.
      getLog().debug(
        { err: error as Error, channel: ref.channel, name },
        'slack.bridge_reaction_add_failed'
      );
    }
  }

  private async removeReactionSafe(ref: SlackMessageRef, name: string): Promise<void> {
    try {
      // `no_reaction` (already removed by a teammate / manual click) and rate
      // limits are non-fatal — the terminal-state add below still fires.
      await this.adapter.getApp().client.reactions.remove({
        channel: ref.channel,
        timestamp: ref.ts,
        name,
      });
    } catch (error) {
      getLog().debug(
        { err: error as Error, channel: ref.channel, name },
        'slack.bridge_reaction_remove_failed'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Block Kit action handlers
  // ─────────────────────────────────────────────────────────────────────────

  private registerActionHandlers(): void {
    if (this.actionHandlersRegistered) return;
    const app = this.adapter.getApp();

    // Bolt's action() callback for a regex matches only block button clicks
    // in our case, so the body/action narrow to BlockButtonAction/ButtonAction.
    // Telling Bolt the generic shape gets us SDK-typed body.user.id etc.
    app.action<BlockButtonAction>(/^approve:/, async ({ ack, body, action }) => {
      await ack();
      await this.handleApprovalDecision(body, action, 'approved');
    });
    app.action<BlockButtonAction>(/^reject:/, async ({ ack, body, action }) => {
      await ack();
      await this.handleApprovalDecision(body, action, 'rejected');
    });
    app.action<BlockButtonAction>(/^cancel:/, async ({ ack, body, action }) => {
      await ack();
      await this.handleCancelClick(body, action);
    });

    this.actionHandlersRegistered = true;
  }

  private async handleApprovalDecision(
    body: BlockButtonAction,
    action: ButtonAction,
    decision: 'approved' | 'rejected'
  ): Promise<void> {
    const actorId = body.user?.id;
    if (!this.assertAuthorized(actorId, decision)) return;

    const parsed = parseActionId(action.action_id ?? '', decision);
    if (!parsed) return;
    const { runId, nodeId } = parsed;

    // Top-level try/catch: applyResolutionEdit must also be guarded because the
    // block builder or chat.update can throw. Bolt has no app.error registered,
    // so an unhandled rejection here means the user sees nothing.
    let outcomeNote: string | undefined;
    try {
      try {
        if (decision === 'approved') {
          const result = await workflowOperations.approveWorkflow(runId);
          outcomeNote =
            result.type === 'interactive_loop'
              ? 'recorded — loop will continue on resume'
              : 'workflow resumed';
        } else {
          const result = await workflowOperations.rejectWorkflow(runId);
          outcomeNote = result.cancelled
            ? result.maxAttemptsReached
              ? 'cancelled — max reject attempts reached'
              : 'cancelled'
            : 'recorded — workflow will retry with feedback';
        }
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId, nodeId, decision }, 'slack.bridge_approval_action_failed');
        // Keep the user-facing note generic — full error stays in logs.
        outcomeNote = 'error: see server logs';
      }

      await this.applyResolutionEdit({
        runId,
        nodeId,
        decision,
        actorId: actorId ?? 'unknown',
        messageTs: body.message?.ts,
        channel: body.channel?.id,
        outcomeNote,
      });
    } catch (error) {
      getLog().error(
        { err: error as Error, runId, nodeId, decision },
        'slack.bridge_approval_handler_failed'
      );
    }
  }

  private async handleCancelClick(body: BlockButtonAction, action: ButtonAction): Promise<void> {
    const actorId = body.user?.id;
    if (!this.assertAuthorized(actorId, 'cancel')) return;

    const actionId = action.action_id ?? '';
    const match = /^cancel:(.+)$/.exec(actionId);
    if (!match) return;
    const runId = match[1] ?? '';
    if (!runId) return;

    try {
      try {
        await workflowOperations.abandonWorkflow(runId);
        getLog().info({ runId, actorId: maskUserId(actorId) }, 'slack.bridge_cancel_dispatched');
        // The eventual workflow_cancelled event will repaint the status message.
        return;
      } catch (error) {
        const err = error as Error;
        // Full error stays in logs; the user-facing message is intentionally
        // generic so internal DB / library errors don't leak into a channel.
        getLog().warn({ err, runId }, 'slack.bridge_cancel_failed');

        // Tell the user something. If we still have run state, drop a note in
        // the thread. Otherwise (run already terminated) try to acknowledge in
        // the channel/thread of the message the button was attached to.
        const state = this.runs.get(runId);
        const fallbackChannel = body.channel?.id;
        const fallbackThreadTs = body.message?.ts;
        const target = state
          ? { channel: state.channel, thread_ts: state.threadTs }
          : fallbackChannel
            ? { channel: fallbackChannel, thread_ts: fallbackThreadTs }
            : undefined;

        if (!target) {
          getLog().info({ runId }, 'slack.bridge_cancel_no_target');
          return;
        }

        try {
          await this.adapter.getApp().client.chat.postMessage({
            channel: target.channel,
            thread_ts: target.thread_ts,
            text: state
              ? `:warning: Could not cancel run \`${runId}\`. Check the server logs or try again.`
              : `:information_source: Run \`${runId}\` already finished — nothing to cancel.`,
          });
        } catch (notifyError) {
          getLog().debug({ err: notifyError as Error, runId }, 'slack.bridge_cancel_notify_failed');
        }
      }
    } catch (error) {
      getLog().error({ err: error as Error, runId }, 'slack.bridge_cancel_handler_failed');
    }
  }

  private async applyResolutionEdit(args: {
    runId: string;
    nodeId: string;
    decision: 'approved' | 'rejected';
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
      getLog().warn(
        { err: error as Error, runId: args.runId, decision: args.decision },
        'slack.bridge_resolution_update_failed'
      );
    }
  }

  private assertAuthorized(
    userId: string | undefined,
    surface: 'approved' | 'rejected' | 'cancel'
  ): boolean {
    if (isSlackUserAuthorized(userId, this.adapter.getAllowedUserIds())) return true;
    getLog().info({ maskedUserId: maskUserId(userId), surface }, 'slack.bridge_unauthorized_click');
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function splitConversationId(conversationId: string): [string, string | undefined] {
  if (!conversationId.includes(':')) return [conversationId, undefined];
  const idx = conversationId.indexOf(':');
  return [conversationId.slice(0, idx), conversationId.slice(idx + 1)];
}

function parseActionId(
  actionId: string,
  prefix: 'approved' | 'rejected'
): { runId: string; nodeId: string } | null {
  const expected = prefix === 'approved' ? 'approve' : 'reject';
  const match = new RegExp(`^${expected}:([^:]+):(.+)$`).exec(actionId);
  if (!match) return null;
  const runId = match[1] ?? '';
  const nodeId = match[2] ?? '';
  if (!runId || !nodeId) return null;
  return { runId, nodeId };
}

function maskUserId(userId: string | undefined): string {
  if (!userId) return 'unknown';
  return `${userId.slice(0, 4)}***`;
}

function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}
