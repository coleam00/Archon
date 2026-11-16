/**
 * What the item tracker writes. Everything here is pure: the tracker reads the facts and
 * these functions decide the subject and the comment body. A body carries only workflow
 * names, statuses, declared outcomes, the proposed change's URL and, when enabled, usage
 * figures; never paths, people, prompts, messages, logs or errors.
 */
import type { ForgeSubjectRef, RepoRef } from '@archon/forge';
import type { TrackedProject } from '@archon/core/config/config-types';
import { isTerminalRunStatus } from '@archon/workflows/schemas/run-status';
import { parseRunUsage } from '@archon/workflows/schemas/run-usage';
import { displayedRunOutcome, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export const ITEM_STATUS_MARKER = '<!-- archon-item-status -->';

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
