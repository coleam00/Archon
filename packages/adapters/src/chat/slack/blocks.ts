/**
 * Side-effect-free so callers can unit-test these without spinning up a
 * Bolt client. Consumed by `adapter.ts` (`sendResultFooter`) and the
 * workflow bridge, both of which feed the output into `chat.postMessage`
 * / `chat.update`.
 */
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import type { types } from '@slack/bolt';
import type { TokenUsage } from '@archon/providers/types';
import {
  isTerminalRunStatus,
  type ApprovalContext,
  type RunTerminalStatus,
  type WorkflowRunOutcome,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';

type KnownBlock = types.KnownBlock;

/** State of a single DAG node as tracked by the workflow bridge. */
export type NodeState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

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
  status: WorkflowRunStatus;
  /** Persisted workflow-authored verdict, or an explicit presentation read failure. */
  authoredOutcome?: WorkflowRunOutcome | 'unavailable';
  /** Final cost in USD; only set once persisted on workflow_runs.metadata.total_cost_usd. */
  totalCostUsd?: number;
  /** Optional failure reason for failed/cancelled runs. */
  failureReason?: string;
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

/**
 * Format a small italic cost footer line.
 * Returns null when there's nothing meaningful to display (no cost AND no tokens).
 */
export function formatCostFooter(input: {
  cost?: number;
  tokens?: TokenUsage;
  stopReason?: string;
}): string | null {
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

export function buildApprovalBlocks(input: {
  runId: string;
  nodeId: string;
  message: string;
  decisions?: ApprovalContext['decisions'];
}): {
  blocks: KnownBlock[];
  fallbackText: string;
} {
  const decisions = getApprovalDecisions(input);
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:pause_button: *Approval needed* — run \`${shortRunId(input.runId)}\`\n\n${input.message}`,
      },
    },
  ];
  // Slack permits at most 25 elements in an actions block and 75 characters in a button label.
  for (let offset = 0; offset < decisions.length; offset += 25) {
    blocks.push({
      type: 'actions',
      block_id: `approval:${input.runId}:${input.nodeId}${offset ? `:${String(offset)}` : ''}`,
      elements: decisions.slice(offset, offset + 25).map(decision => ({
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
        action_id:
          decision.id === 'approve' || decision.id === 'reject'
            ? `${decision.id}:${input.runId}:${input.nodeId}`
            : `respond:${input.runId}:${input.nodeId}:${decision.id}`,
      })),
    });
  }
  const choices = decisions.map(decision => {
    const display = decision.label ? `${decision.label} (${decision.id})` : decision.id;
    return `${display}: /archon-workflow respond ${input.runId} ${decision.id} [text]`;
  });
  return {
    blocks,
    fallbackText: `Approval needed for run ${shortRunId(input.runId)}\n${input.message}\n${choices.join('\n')}`,
  };
}

/**
 * Block Kit message used to show the resolution of an approval after a button
 * was clicked. Buttons are removed so the message is no longer interactive.
 */
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

/**
 * Block Kit status message shown for the duration of a workflow run, edited
 * in place as nodes start and complete. Includes a Cancel button while the
 * run is non-terminal; the button is removed on terminal events.
 */
export function buildStatusBlocks(
  snapshot: RunSnapshot,
  now: number = Date.now()
): { blocks: KnownBlock[]; fallbackText: string } {
  const elapsed = formatElapsed(Math.max(0, now - snapshot.startedAt));
  const terminalStatus = isTerminalRunStatus(snapshot.status) ? snapshot.status : undefined;
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
    }`,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Slack reaction names corresponding to workflow lifecycle states. */
export const REACTION_RUNNING = 'arrows_counterclockwise';
export const REACTION_SUCCESS = 'white_check_mark';
export const REACTION_FAILURE = 'x';
