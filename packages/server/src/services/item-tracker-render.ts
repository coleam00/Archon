/**
 * What the item tracker writes. Everything here is pure: the tracker reads the facts and
 * these functions decide the subject and the comment bodies. A body carries only workflow
 * names, run ids, statuses, declared outcomes, the proposed change's URL, the text of a
 * question, an ask or a ruling with the command that answers it and, when enabled, usage
 * figures; never paths, people, prompts, chat messages, logs, results or errors.
 */
import type { ForgeSubjectRef, RepoRef } from '@archon/forge';
import type { TrackedProject } from '@archon/core/config/config-types';
import { getApprovalDecisions, OTHER_ATTENTION_OPTION } from '@archon/workflows/schemas/dag-node';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import type { ItemRuling } from '@archon/workflows/schemas/item-ruling';
import type { RunAttention } from '@archon/workflows/schemas/run-attention';
import { isTerminalRunStatus } from '@archon/workflows/schemas/run-status';
import { parseRunUsage } from '@archon/workflows/schemas/run-usage';
import {
  displayedRunOutcome,
  isApprovalContext,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';

/** The one status comment's marker; every other comment's marker names the fact it posts. */
export const ITEM_STATUS_MARKER = '<!-- archon-item-status -->';
const marker = (kind: string, id: string): string => `<!-- archon-item-${kind}: ${id} -->`;

/**
 * The tracker subject an item key names under the project's key rules, or undefined when
 * it names none. The rest of the key after the prefix must be a plain issue or pull
 * request number: `issue-0`, `issue-07` and `issue-12a` name nothing.
 */
export function trackerSubject(
  project: Pick<TrackedProject, 'keys'>,
  repo: RepoRef,
  itemKey: string
): ForgeSubjectRef | undefined {
  const rule = project.keys.find(candidate => itemKey.startsWith(candidate.prefix));
  if (!rule) return undefined;
  const rest = itemKey.slice(rule.prefix.length);
  if (!/^[1-9][0-9]*$/.test(rest)) return undefined;
  const number = Number(rest);
  if (!Number.isSafeInteger(number)) return undefined;
  return { kind: rule.kind, ref: { repo, number } };
}

export type StatusRun = Pick<
  WorkflowRun,
  'workflow_name' | 'status' | 'outcome' | 'completed_outcome' | 'metadata'
>;

/** The one status comment of an item: its runs in start order, and where the change is proposed. */
export function renderItemStatus(
  runs: readonly StatusRun[],
  proposedChange: string | undefined,
  includeUsage: boolean
): string {
  const live = runs.some(run => !isTerminalRunStatus(run.status));
  const header = ['Stage', 'Status', 'Outcome', ...(includeUsage ? ['Cost', 'Tokens'] : [])];
  const rows = runs.map(run => [
    cell(run.workflow_name),
    // Every live status reads the same: the comment is edited only when a stage starts
    // or ends, so a finer status (paused, running) would go stale between edits.
    isTerminalRunStatus(run.status) ? run.status : 'in progress',
    cell(displayedRunOutcome(run) ?? ''),
    ...(includeUsage ? usageCells(run) : []),
  ]);
  return [
    ITEM_STATUS_MARKER,
    live
      ? '**Archon** is working on this item.'
      : '**Archon** has no stage in progress on this item.',
    '',
    tableRow(header),
    tableRow(header.map(() => '---')),
    ...rows.map(tableRow),
    ...(proposedChange ? ['', `Proposed change: ${proposedChange}`] : []),
    '',
  ].join('\n');
}

function usageCells(run: StatusRun): [string, string] {
  const usage = parseRunUsage(run.metadata);
  const cost = usage.costUsd === undefined ? '' : `$${usage.costUsd.toFixed(2)}`;
  if (usage.tokensUnknown) return [cost, 'unknown'];
  const tokens = usage.tokens;
  return [cost, tokens ? `${String(tokens.input)} in / ${String(tokens.output)} out` : ''];
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** One line, with the table's separator escaped. */
function cell(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('|', '\\|');
}

/** A comment posted once: its marker, its body and the ledger key that records it. */
export interface TrackerComment {
  marker: string;
  body: string;
}

/** The attentions a question comment is posted for: a gate, or an attention wait. */
export type QuestionAttention = Extract<RunAttention, { kind: 'awaiting_response' | 'attention' }>;

export function questionKey(attention: QuestionAttention): string {
  const nodeId =
    attention.kind === 'awaiting_response' ? attention.respondTo.nodeId : attention.nodeId;
  return `question:${nodeId}:${attention.occurrence}`;
}

/** A paused run's question: its message, its options and the command that answers it. */
export function renderQuestion(
  run: Pick<WorkflowRun, 'id' | 'workflow_name' | 'metadata'>,
  attention: QuestionAttention
): TrackerComment {
  const commentMarker = marker('question', `${run.id}:${questionKey(attention)}`);
  const lines = [
    commentMarker,
    `**Archon** is waiting for an answer on the \`${run.workflow_name}\` stage.`,
    '',
    quote(attention.message),
    '',
  ];
  if (attention.kind === 'awaiting_response') {
    const approval = run.metadata.approval;
    const decisions = isApprovalContext(approval) ? getApprovalDecisions(approval) : [];
    lines.push(
      ...(decisions.length > 0
        ? ['Decisions:', ...decisions.map(decision => `- \`${decision.id}\``), '']
        : []),
      `Answer with \`archon workflow respond ${run.id} <decision> [text]\`.`
    );
  } else {
    const options = attention.options.filter(option => option.id !== OTHER_ATTENTION_OPTION.id);
    const answer = `archon workflow answer ${run.id} --occurrence ${attention.occurrence}`;
    lines.push(
      ...(options.length > 0
        ? [
            'Options:',
            ...options.map(
              option =>
                `- \`${option.id}\`${option.label ? `: ${line(option.label)}` : ''}${option.does ? `. ${line(option.does)}` : ''}`
            ),
            '',
          ]
        : []),
      ...(attention.recommendation
        ? [
            `Recommended: \`${attention.recommendation.option}\`. ${line(attention.recommendation.why)}`,
            '',
          ]
        : []),
      options.length > 0
        ? `Answer with \`${answer} --choose <option>\`${attention.form === 'multi_select' ? ', repeating `--choose` for each option' : ''}.`
        : `Answer with \`${answer} --text "<answer>"\`.`,
      ...(attention.other === true
        ? [`None of these? Answer with \`${answer} --choose other --text "<answer>"\`.`]
        : [])
    );
  }
  return { marker: commentMarker, body: [...lines, ''].join('\n') };
}

/** An open ask: its question, context and options, and the commands that answer it. */
export function renderAsk(ask: StoredItemAsk): TrackerComment {
  const commentMarker = marker('ask', ask.id);
  const ref = `ask:${ask.id}`;
  const { question, context, options, recommendation } = ask.ask;
  return {
    marker: commentMarker,
    body: [
      commentMarker,
      `**Archon** has a question on this item, from the \`${ask.workflowName}\` stage.`,
      '',
      `**${line(question)}**`,
      '',
      quote(context),
      '',
      'Options:',
      ...options.map(
        option => `- \`${option.id}\`: ${line(option.does)} Cost: ${line(option.cost)}`
      ),
      '',
      `Recommended: \`${recommendation.option}\`. ${line(recommendation.why)}`,
      '',
      `Answer with \`archon workflow answer --ref ${ref} --choose <option>\`, or in your own words with \`--choose other --text "<answer>"\`. Withdraw it with \`archon workflow answer --withdraw ${ref}\`.`,
      '',
    ].join('\n'),
  };
}

/** A recorded ruling: its text and when it was recorded. Never who recorded it. */
export function renderRuling(ruling: ItemRuling): TrackerComment {
  const commentMarker = marker('ruling', ruling.id);
  return {
    marker: commentMarker,
    body: [
      commentMarker,
      `**Archon** recorded a ruling on this item (${ruling.at}):`,
      '',
      quote(ruling.text),
      '',
    ].join('\n'),
  };
}

/** The work on the item is over: how the last stage ended, and where the change is proposed. */
export function renderResult(
  run: Pick<WorkflowRun, 'id'> & StatusRun,
  proposedChange: string | undefined,
  includeUsage: boolean
): TrackerComment {
  const commentMarker = marker('result', run.id);
  const outcome = displayedRunOutcome(run);
  const [cost, tokens] = includeUsage ? usageCells(run) : ['', ''];
  const usage = [cost && `cost ${cost}`, tokens && `tokens ${tokens}`].filter(Boolean).join(', ');
  return {
    marker: commentMarker,
    body: [
      commentMarker,
      `**Archon** finished its work on this item: the \`${run.workflow_name}\` stage ${run.status}${outcome ? ` with outcome \`${line(outcome)}\`` : ''}.`,
      ...(proposedChange ? ['', `Proposed change: ${proposedChange}`] : []),
      ...(usage ? ['', `Usage: ${usage}.`] : []),
      '',
    ].join('\n'),
  };
}

/** Free text as a Markdown quote, so its own lines cannot become structure. */
function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map(textLine => `> ${textLine}`)
    .join('\n');
}

function line(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
