import {
  chatRunActionSchema,
  type ChatRunEvent,
  type ChatResultFooter,
} from '@archon/chat-contract';
import type { types } from '@slack/bolt';

type TerminalEvent = Extract<ChatRunEvent, { type: 'terminal' }>;
type ApprovalEvent = Extract<ChatRunEvent, { type: 'approval_pending' }>;
export type RunTerminalStatus = TerminalEvent['status'];

type KnownBlock = types.KnownBlock;

export type NodeState = 'pending' | Extract<ChatRunEvent, { type: 'node_state' }>['state'];

export interface NodeSnapshot {
  nodeId: string;
  nodeName: string;
  state: NodeState;
  durationMs?: number;
  error?: string;
}

export interface RunSnapshot {
  runId: string;
  workflowName: string;
  startedAt: number;
  nodes: NodeSnapshot[];
  status: 'running' | 'paused' | RunTerminalStatus;
  authoredOutcome?: TerminalEvent['authoredOutcome'];
  totalCostUsd?: number;
  failureReason?: string;
  approvalDeliveryFailed?: boolean;
}

const NODE_GLYPH: Record<NodeState, string> = {
  pending: ':white_circle:',
  running: ':hourglass_flowing_sand:',
  completed: ':white_check_mark:',
  failed: ':x:',
  skipped: ':fast_forward:',
};

const TERMINAL_HEADER: Record<RunTerminalStatus, string> = {
  completed: ':white_check_mark: Workflow completed',
  failed: ':x: Workflow failed',
  cancelled: ':no_entry: Workflow cancelled',
};

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}m ${remS}s`;
}

export function formatCostFooter(input: Omit<ChatResultFooter, 'conversationId'>): string | null {
  const parts: string[] = [];
  if (typeof input.cost === 'number' && Number.isFinite(input.cost)) {
    parts.push(`cost: $${input.cost.toFixed(4)}`);
  }
  if (input.tokens) {
    const summed = (input.tokens.input ?? 0) + (input.tokens.output ?? 0);
    const total = input.tokens.total ?? summed;
    if (total > 0) {
      parts.push(`${formatTokenCount(total)} tokens`);
    }
  }
  if (input.stopReason) {
    parts.push(`stop: ${input.stopReason}`);
  }
  if (parts.length === 0) return null;
  return `_${parts.join(' · ')}_`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export type SlackApprovalAction = Pick<ApprovalEvent, 'runId' | 'nodeId' | 'pauseId'> &
  Pick<
    Extract<import('@archon/chat-contract').ChatRunAction, { action: 'respond' }>['response'],
    'decision'
  >;

export function parseApprovalValue(value: string): SlackApprovalAction | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || !('runId' in raw)) return undefined;
  const parsed = chatRunActionSchema.safeParse({
    action: 'respond',
    runId: raw.runId,
    sender: { platformUserId: 'button' },
    response: raw,
  });
  if (!parsed.success || parsed.data.action !== 'respond' || !parsed.data.response.nodeId)
    return undefined;
  return {
    runId: parsed.data.runId,
    nodeId: parsed.data.response.nodeId,
    decision: parsed.data.response.decision,
    pauseId: parsed.data.response.pauseId,
  };
}

export function buildApprovalBlocks(input: {
  runId: string;
  nodeId: string;
  message: string;
  decisions: ApprovalEvent['decisions'];
  pauseId?: string;
}): {
  blocks: KnownBlock[];
  fallbackText: string;
} {
  const decisions = input.decisions;
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:pause_button: *Approval needed* — run \`${shortRunId(input.runId)}\`\n\n${input.message}`,
      },
    },
  ];
  const values = decisions.map(decision =>
    JSON.stringify({
      runId: input.runId,
      nodeId: input.nodeId,
      pauseId: input.pauseId,
      decision: decision.id,
    } satisfies SlackApprovalAction)
  );
  const controlsFit = decisions.length <= 49 * 25 && values.every(value => value.length <= 2000);
  // Slack allows 50 blocks, 25 controls per actions block, 2000 characters per value, and 75 per label.
  for (let offset = 0; controlsFit && offset < decisions.length; offset += 25) {
    blocks.push({
      type: 'actions',
      block_id: `approval:${String(offset)}`,
      elements: decisions.slice(offset, offset + 25).map((decision, index) => ({
        type: 'button',
        ...(decision.id === 'approve'
          ? { style: 'primary' as const }
          : decision.id === 'reject'
            ? { style: 'danger' as const }
            : {}),
        text: {
          type: 'plain_text',
          text: truncate(
            decision.label ??
              (decision.id === 'approve'
                ? 'Approve'
                : decision.id === 'reject'
                  ? 'Reject'
                  : decision.id),
            75
          ),
          emoji: true,
        },
        action_id: `respond:${String(offset + index)}`,
        value: values[offset + index],
      })),
    });
  }
  const choices = decisions.map(decision => {
    const display = decision.label ? `${decision.label} (${decision.id})` : decision.id;
    return `${display}: /archon-workflow respond ${input.runId} ${decision.id} [text]`;
  });
  return {
    blocks: controlsFit ? blocks : [],
    fallbackText: `Approval needed for run ${shortRunId(input.runId)}\n${input.message}\n${choices.join('\n')}`,
  };
}

export function buildApprovalResolutionBlocks(input: {
  runId: string;
  nodeId: string;
  decision: string;
  actorUserId: string;
  originalMessage: string;
  outcomeNote?: string;
}): { blocks: KnownBlock[]; fallbackText: string } {
  const icon = input.decision === 'reject' ? ':x:' : ':white_check_mark:';
  const verb =
    input.decision === 'approve'
      ? 'Approved'
      : input.decision === 'reject'
        ? 'Rejected'
        : `Selected ${input.decision}`;
  const lines: string[] = [
    `${icon} *${verb}* by <@${input.actorUserId}> — run \`${shortRunId(input.runId)}\``,
    '',
    input.originalMessage,
  ];
  if (input.outcomeNote) {
    lines.push('', `_${input.outcomeNote}_`);
  }
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
  ];
  return {
    blocks,
    fallbackText: `${verb} run ${shortRunId(input.runId)}`,
  };
}

export function buildClosedApprovalBlocks(input: {
  runId: string;
  terminalStatus: RunTerminalStatus;
  originalMessage: string;
}): { blocks: KnownBlock[]; fallbackText: string } {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${TERMINAL_HEADER[input.terminalStatus]} — approval closed for run \`${shortRunId(input.runId)}\`\n\n${input.originalMessage}`,
      },
    },
  ];
  return {
    blocks,
    fallbackText: `Approval closed for ${input.terminalStatus} run ${shortRunId(input.runId)}`,
  };
}

export function buildStatusBlocks(
  snapshot: RunSnapshot,
  now: number = Date.now()
): { blocks: KnownBlock[]; fallbackText: string } {
  const elapsed = formatElapsed(Math.max(0, now - snapshot.startedAt));
  const terminalStatus =
    snapshot.status !== 'running' && snapshot.status !== 'paused' ? snapshot.status : undefined;
  const header = terminalStatus
    ? TERMINAL_HEADER[terminalStatus]
    : snapshot.status === 'paused'
      ? ':pause_button: Workflow paused'
      : ':arrows_counterclockwise: Workflow running';

  const authoredOutcomeLabel =
    snapshot.authoredOutcome === 'unavailable'
      ? 'unavailable — failed to read persisted run'
      : snapshot.authoredOutcome === undefined
        ? undefined
        : `\`${snapshot.authoredOutcome}\``;
  const runFacts = authoredOutcomeLabel
    ? `\n*Execution status:* \`${snapshot.status}\` · *Authored outcome:* ${authoredOutcomeLabel}`
    : '';
  const headerSection: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${header}${runFacts}\n*Workflow:* \`${snapshot.workflowName}\` · *Run:* \`${shortRunId(snapshot.runId)}\` · *Elapsed:* ${elapsed}`,
    },
  };

  const blocks: KnownBlock[] = [headerSection];
  const approvalRecovery =
    snapshot.status === 'paused' && snapshot.approvalDeliveryFailed
      ? `Approval card could not be delivered. Run \`${snapshot.runId}\` is awaiting approval. Open the run in the Web UI to respond, or check \`/archon-workflow status ${snapshot.runId}\` for the gate and respond with \`/archon-workflow respond\`.`
      : undefined;
  if (approvalRecovery) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:warning: ${approvalRecovery}` },
    });
  }

  if (snapshot.nodes.length > 0) {
    const lines = snapshot.nodes.map(n => {
      const glyph = NODE_GLYPH[n.state];
      const duration =
        n.state === 'completed' && typeof n.durationMs === 'number'
          ? ` · ${formatElapsed(n.durationMs)}`
          : '';
      const errSuffix = n.state === 'failed' && n.error ? ` — ${truncate(n.error, 120)}` : '';
      return `${glyph} \`${n.nodeName}\`${duration}${errSuffix}`;
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    });
  }

  const footerParts: string[] = [];
  if (terminalStatus && typeof snapshot.totalCostUsd === 'number') {
    footerParts.push(`total cost: $${snapshot.totalCostUsd.toFixed(4)}`);
  }
  if ((snapshot.status === 'failed' || snapshot.status === 'cancelled') && snapshot.failureReason) {
    footerParts.push(`reason: ${truncate(snapshot.failureReason, 200)}`);
  }
  if (footerParts.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footerParts.map(p => `_${p}_`).join(' · ') }],
    });
  }

  if (!terminalStatus) {
    blocks.push({
      type: 'actions',
      block_id: `run-controls:${snapshot.runId}`,
      elements: [
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Cancel', emoji: true },
          action_id: `cancel:${snapshot.runId}`,
        },
      ],
    });
  }

  return {
    blocks,
    fallbackText: `${
      terminalStatus
        ? `${TERMINAL_HEADER[terminalStatus]} (${snapshot.workflowName})`
        : snapshot.status === 'paused'
          ? `Workflow ${snapshot.workflowName} paused`
          : `Workflow ${snapshot.workflowName} running`
    }${
      snapshot.authoredOutcome
        ? ` · authored outcome: ${snapshot.authoredOutcome === 'unavailable' ? 'unavailable — failed to read persisted run' : snapshot.authoredOutcome}`
        : ''
    }${approvalRecovery ? ` · ${approvalRecovery}` : ''}`,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export const REACTION_RUNNING = 'arrows_counterclockwise';
export const REACTION_SUCCESS = 'white_check_mark';
export const REACTION_FAILURE = 'x';
