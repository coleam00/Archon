import {
  chatRunActionSchema,
  type ChatAttentionNotice,
  type ChatRunAction,
  type ChatRunEvent,
  type ChatResultFooter,
} from '@archon/chat-contract';
import type { types } from '@slack/bolt';
import { descriptor } from './descriptor';

type TerminalEvent = Extract<ChatRunEvent, { type: 'terminal' }>;
type ApprovalEvent = Extract<ChatRunEvent, { type: 'approval_pending' }>;
type Decision = ApprovalEvent['decisions'][number];
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
  Pick<Extract<ChatRunAction, { action: 'respond' }>['response'], 'decision'>;

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

function decisionButton(decision: Decision): Omit<types.Button, 'action_id' | 'value'> {
  const label =
    decision.label ??
    (decision.id === 'approve' ? 'Approve' : decision.id === 'reject' ? 'Reject' : decision.id);
  return {
    type: 'button',
    ...(decision.id === 'approve'
      ? { style: 'primary' as const }
      : decision.id === 'reject'
        ? { style: 'danger' as const }
        : {}),
    text: { type: 'plain_text', text: truncate(label, 75), emoji: true },
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
        ...decisionButton(decision),
        action_id: `respond:${String(offset + index)}`,
        value: values[offset + index],
      })),
    });
  }
  const choices = decisions.map(decision => {
    const display = decision.label ? `${decision.label} (${decision.id})` : decision.id;
    return `${display}: ${descriptor.workflowCommand.prefix}respond ${input.runId} ${decision.id} [text]`;
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

  const blocks: KnownBlock[] = [buildStatusHeader(snapshot, header, elapsed)];
  const approvalRecovery =
    snapshot.status === 'paused' && snapshot.approvalDeliveryFailed
      ? `Approval card could not be delivered. Run \`${snapshot.runId}\` is awaiting approval. Open the run in the Web UI to respond, or check \`${descriptor.workflowCommand.prefix}get ${snapshot.runId}\` for the gate and respond with \`${descriptor.workflowCommand.prefix}respond\`.`
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

  const footer = buildStatusFooter(snapshot, terminalStatus);
  if (footer) blocks.push(footer);

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
    fallbackText: statusFallbackText(snapshot, terminalStatus, approvalRecovery),
  };
}

function buildStatusHeader(snapshot: RunSnapshot, header: string, elapsed: string): KnownBlock {
  const authoredOutcomeLabel =
    snapshot.authoredOutcome === 'unavailable'
      ? 'unavailable — failed to read persisted run'
      : snapshot.authoredOutcome === undefined
        ? undefined
        : `\`${snapshot.authoredOutcome}\``;
  const runFacts = authoredOutcomeLabel
    ? `\n*Execution status:* \`${snapshot.status}\` · *Authored outcome:* ${authoredOutcomeLabel}`
    : '';
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${header}${runFacts}\n*Workflow:* \`${snapshot.workflowName}\` · *Run:* \`${shortRunId(snapshot.runId)}\` · *Elapsed:* ${elapsed}`,
    },
  };
}

function buildStatusFooter(
  snapshot: RunSnapshot,
  terminalStatus: RunTerminalStatus | undefined
): KnownBlock | undefined {
  const footerParts: string[] = [];
  if (terminalStatus && typeof snapshot.totalCostUsd === 'number') {
    footerParts.push(`total cost: $${snapshot.totalCostUsd.toFixed(4)}`);
  }
  if ((snapshot.status === 'failed' || snapshot.status === 'cancelled') && snapshot.failureReason) {
    footerParts.push(`reason: ${truncate(snapshot.failureReason, 200)}`);
  }
  if (footerParts.length > 0) {
    return {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footerParts.map(p => `_${p}_`).join(' · ') }],
    };
  }
  return undefined;
}

function statusFallbackText(
  snapshot: RunSnapshot,
  terminalStatus: RunTerminalStatus | undefined,
  approvalRecovery: string | undefined
): string {
  return `${
    terminalStatus
      ? `${TERMINAL_HEADER[terminalStatus]} (${snapshot.workflowName})`
      : snapshot.status === 'paused'
        ? `Workflow ${snapshot.workflowName} paused`
        : `Workflow ${snapshot.workflowName} running`
  }${
    snapshot.authoredOutcome
      ? ` · authored outcome: ${snapshot.authoredOutcome === 'unavailable' ? 'unavailable — failed to read persisted run' : snapshot.authoredOutcome}`
      : ''
  }${approvalRecovery ? ` · ${approvalRecovery}` : ''}`;
}

type OpenNotice = Exclude<ChatAttentionNotice, { type: 'terminal' }>;
type TerminalNotice = Extract<ChatAttentionNotice, { type: 'terminal' }>;
type WithoutSender<T> = T extends unknown ? Omit<T, 'sender'> : never;
/** The run action a notice control carries; the clicking member becomes its sender. */
export type SlackNoticeAction = WithoutSender<ChatRunAction>;

export const NOTICE_ACTION_PATTERN = /^attention:/;
export const NOTICE_COMPOSE = 'attention:compose';
export const NOTICE_PICK = 'attention:pick';
export const NOTICE_SUBMIT = 'attention:submit';
const NOTICE_CHOOSE = 'attention:choose';

export function parseNoticeAction(
  value: string | undefined,
  platformUserId: string
): ChatRunAction | undefined {
  if (value === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const parsed = chatRunActionSchema.safeParse({ ...raw, sender: { platformUserId } });
  return parsed.success ? parsed.data : undefined;
}

function plainButton(
  text: string,
  style?: 'primary' | 'danger'
): Omit<types.Button, 'action_id' | 'value'> {
  return { type: 'button', ...(style ? { style } : {}), text: { type: 'plain_text', text } };
}

function noticeButton(
  base: Omit<types.Button, 'action_id' | 'value'>,
  actionId: string,
  action: SlackNoticeAction
): types.Button | undefined {
  const value = JSON.stringify(action);
  return value.length <= 2000 ? { ...base, action_id: actionId, value } : undefined;
}

function actionBlocks(controls: (types.Button | undefined)[]): KnownBlock[] | undefined {
  // Leave room for the notice text inside Slack's 50-block message limit.
  if (controls.length > 45 * 25) return undefined;
  const buttons = controls.filter(control => control !== undefined);
  if (buttons.length !== controls.length) return undefined;
  const blocks: KnownBlock[] = [];
  for (let offset = 0; offset < buttons.length; offset += 25)
    blocks.push({ type: 'actions', elements: buttons.slice(offset, offset + 25) });
  return blocks;
}

/** The notice's answer controls, or undefined when they exceed Slack's limits. */
function noticeControls(notice: OpenNotice): KnownBlock[] | undefined {
  const { runId, nodeId, pauseId } = notice;
  const choices = (options: Decision[], action: (id: string) => SlackNoticeAction) =>
    options.map((option, index) =>
      noticeButton(decisionButton(option), `${NOTICE_CHOOSE}:${String(index)}`, action(option.id))
    );
  if (notice.type === 'gate') {
    const decisions = choices(notice.decisions, decision => ({
      action: 'respond',
      runId,
      response: { nodeId, pauseId, decision },
    }));
    // A reply approves the loop gate with feedback, so the loop runs another iteration.
    const reply =
      notice.gateType === 'interactive_loop'
        ? [
            noticeButton(plainButton('Reply'), NOTICE_COMPOSE, {
              action: 'respond',
              runId,
              response: { nodeId, pauseId, decision: 'approve' },
            }),
          ]
        : [];
    return actionBlocks([...decisions, ...reply]);
  }
  const cancel: types.Button = { ...plainButton('Cancel', 'danger'), action_id: `cancel:${runId}` };
  if (!pauseId)
    return actionBlocks([
      noticeButton(plainButton('Resume', 'primary'), `${NOTICE_CHOOSE}:0`, {
        action: 'resume',
        runId,
      }),
      cancel,
    ]);
  const answer = (choose: string[]): SlackNoticeAction => ({
    action: 'answer',
    runId,
    response: { nodeId, pauseId, choose },
  });
  switch (notice.form) {
    case 'message':
      return actionBlocks([
        noticeButton(plainButton('Answer', 'primary'), NOTICE_COMPOSE, answer([])),
        cancel,
      ]);
    case 'approval':
    case 'select':
      return actionBlocks([...choices(notice.options, id => answer([id])), cancel]);
    case 'multi_select': {
      const submit = noticeButton(plainButton('Submit', 'primary'), NOTICE_SUBMIT, answer([]));
      // Slack allows 100 options per menu and 150 characters per option value.
      if (!submit || notice.options.length > 100 || notice.options.some(o => o.id.length > 150))
        return undefined;
      return [
        {
          type: 'actions',
          block_id: NOTICE_PICK,
          elements: [
            {
              type: 'multi_static_select',
              action_id: NOTICE_PICK,
              placeholder: { type: 'plain_text', text: 'Choose options' },
              options: notice.options.map(option => ({
                text: { type: 'plain_text', text: truncate(option.label ?? option.id, 75) },
                value: option.id,
              })),
            },
            submit,
            cancel,
          ],
        },
      ];
    }
  }
}

function noticeIntro(notice: OpenNotice, header: string): KnownBlock {
  // Slack rejects section text over 3000 characters.
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: truncate(`${header}\n\n${notice.message}`, 3000) },
  };
}

function noticeHeader(notice: OpenNotice | TerminalNotice): string {
  return `*${notice.workflowName}* · run \`${shortRunId(notice.runId)}\``;
}

export function buildAttentionNoticeBlocks(notice: OpenNotice): {
  blocks: KnownBlock[];
  fallbackText: string;
} {
  const controls = noticeControls(notice);
  return {
    blocks: [
      noticeIntro(notice, `:bell: Needs attention — ${noticeHeader(notice)}`),
      ...(controls ?? [
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'Too many choices to answer in Slack; answer in Archon.' },
          ],
        },
      ]),
    ],
    fallbackText: truncate(
      `${notice.workflowName} needs attention (run ${shortRunId(notice.runId)}): ${notice.message}`,
      300
    ),
  };
}

/** A notice whose controls no longer apply: answered, or closed by the run finishing. */
export function buildSettledNoticeBlocks(
  notice: OpenNotice | undefined,
  runId: string,
  outcome: string
): { blocks: KnownBlock[]; fallbackText: string } {
  const header = notice ? noticeHeader(notice) : `run \`${shortRunId(runId)}\``;
  return {
    blocks: [
      notice
        ? noticeIntro(notice, `${outcome} — ${header}`)
        : { type: 'section', text: { type: 'mrkdwn', text: `${outcome} — ${header}` } },
    ],
    fallbackText: `${outcome} — run ${shortRunId(runId)}`,
  };
}

export function buildNoticeTerminalBlocks(notice: TerminalNotice): {
  blocks: KnownBlock[];
  fallbackText: string;
} {
  const facts: string[] = [];
  if (notice.authoredOutcome)
    facts.push(
      `authored outcome: ${notice.authoredOutcome === 'unavailable' ? 'unavailable — failed to read persisted run' : notice.authoredOutcome}`
    );
  if (notice.totalCostUsd !== undefined)
    facts.push(`total cost: $${notice.totalCostUsd.toFixed(4)}`);
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${TERMINAL_HEADER[notice.status]} — ${noticeHeader(notice)}` },
    },
  ];
  if (facts.length > 0)
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: facts.map(fact => `_${fact}_`).join(' · ') }],
    });
  return {
    blocks,
    fallbackText: `${TERMINAL_HEADER[notice.status]} (${notice.workflowName})`,
  };
}

/** The free-text answer form. `private_metadata` carries the clicked control back. */
export function buildComposeView(metadata: string): types.ModalView {
  return {
    type: 'modal',
    callback_id: NOTICE_COMPOSE,
    private_metadata: metadata,
    title: { type: 'plain_text', text: 'Answer' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: NOTICE_COMPOSE,
        label: { type: 'plain_text', text: 'Your answer' },
        element: { type: 'plain_text_input', action_id: NOTICE_COMPOSE, multiline: true },
      },
    ],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export const REACTION_RUNNING = 'arrows_counterclockwise';
export const REACTION_SUCCESS = 'white_check_mark';
export const REACTION_FAILURE = 'x';
