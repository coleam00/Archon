/**
 * The intake bench scorer: one column per version, from each version's latest line
 * per row. It reports the hard checks, every bar with its value, `type` agreement as
 * a confusion matrix, leaks, cost and time, and beside each disagreement the versions
 * that got the row right. It never picks a winner.
 *
 * The judgement bars (duplicates, fixed, not planned) are the operator's marks: a row
 * counts when the operator marked that version's run right. The structured signals
 * the scorer can read on its own stand beside them. A run that did not pass counts
 * against the bars as not right. A row whose batch failed a hard check or whose run
 * looked the issue up is left out of the accuracy numbers and counted separately.
 */

import { join } from 'node:path';
import { SAMPLES_FILE, appendLine, isId, latestLines, readLines } from '../../../.shared/bench.ts';
import type { WorkType } from '../../../.shared/labels.ts';
import { isObject } from '../../../.shared/typed.ts';
import { type BatchChecks, CHECKS_FILE, type CheckName, type Line } from './runner.ts';
import { type BenchSet, GROUP_OPEN, type Group, type Row } from './set.ts';

export const MARKS = ['right', 'wrong', 'partly'] as const;
export type MarkValue = (typeof MARKS)[number];
export const MARKS_FILE = 'marks.jsonl';

/** The operator's judgement of one version's run on one row. */
export interface Mark {
  readonly at: string;
  readonly run_id: string;
  readonly batch: number;
  readonly row: string;
  readonly label: string;
  readonly mark: MarkValue;
  readonly note: string;
}

export function recordMark(outDir: string, mark: Omit<Mark, 'at'>): Mark {
  if (!MARKS.includes(mark.mark)) throw new Error(`a mark is one of ${MARKS.join(', ')}`);
  if (!isId(mark.run_id) || !isId(mark.label)) throw new Error('a mark names a run and a version label');
  const recorded: Mark = { at: new Date().toISOString(), ...mark };
  appendLine(join(outDir, MARKS_FILE), recorded);
  return recorded;
}

/** The newest mark on each run. */
export function readMarks(outDir: string): Map<string, Mark> {
  return latestLines(join(outDir, MARKS_FILE), line => String(line.run_id)) as unknown as Map<string, Mark>;
}

export function readChecks(outDir: string): Map<string, BatchChecks> {
  return latestLines(join(outDir, CHECKS_FILE), line => String(line.batch_run)) as unknown as Map<string, BatchChecks>;
}

/**
 * Each version's latest line per row, versions in the order they first ran. A live
 * line judged a copy, not the issue itself, so it is its version's own column.
 */
export function latestByVersion(outDir: string): Map<string, Map<string, Line>> {
  const versions = new Map<string, Map<string, Line>>();
  for (const raw of readLines(join(outDir, SAMPLES_FILE))) {
    const line = raw as unknown as Line;
    if (!isObject(raw.version) || typeof line.row !== 'string') continue;
    const column = line.mode === 'live' ? `${line.version.label} (live)` : line.version.label;
    const rows = versions.get(column) ?? new Map<string, Line>();
    rows.set(line.row, line);
    versions.set(column, rows);
  }
  return versions;
}

/** Which workflow judged a line, and how: archon-triage directly, or intake in eval or live mode. */
export function judgedBy(line: Line): string {
  return line.workflow === 'triage' ? 'archon-triage' : `intake ${line.mode}`;
}

/** Whether a line's batch run passed its hard checks; a run with no record did not finish. */
export function batchPassed(line: Line, checks: ReadonlyMap<string, BatchChecks>): boolean {
  return checks.get(line.batch_run)?.passed === true;
}

/** A line the bars count: its batch passed and it looked nothing up. A run that did not pass counts as not right. */
function isScored(line: Line, checks: ReadonlyMap<string, BatchChecks>): boolean {
  return batchPassed(line, checks) && line.leak.length === 0 && line.trust === 'auto';
}

/** A scored line whose run passed, so its verdict can be read and marked. */
export function isJudged(line: Line, checks: ReadonlyMap<string, BatchChecks>): boolean {
  return isScored(line, checks) && line.passed;
}

/**
 * Whether proposing to close this row is a false close: the issue was still open when
 * the set was pinned, and no disposition of the operator's says it should close. On a
 * closed row, a close proposal is what the duplicate, fixed and not-planned bars reward.
 */
export function falseClose(row: Row, verdict: Line['verdict']): boolean {
  return verdict?.contract === 'NO_ACTION' && GROUP_OPEN[row.group] && row.known.disposition?.contract !== 'NO_ACTION';
}

/** Whether a verdict links the canonical issue, by its close proposal or its maintainer recommendation. */
function citesCanonical(verdict: Line['verdict'], canonical: string): boolean {
  const links = [...(verdict?.closure?.kind === 'duplicate' ? [verdict.closure.url] : []), ...(verdict?.blocked_by ?? [])];
  return links.some(url => url.toLowerCase() === canonical.toLowerCase());
}

const BARS = [
  { group: 'duplicate', label: 'duplicates found with the right canonical link', at_least: 0.7 },
  { group: 'fixed', label: 'fixed by a pull request, recognised', at_least: 0.7 },
  { group: 'not_planned', label: 'not planned, flagged out of scope or proposed for close', at_least: 0.5 },
] as const satisfies readonly { group: Group; label: string; at_least: number }[];
const TYPE_BAR = 0.8;

/** Each hard check as the score names it. */
const HARD_CHECKS: Readonly<Record<CheckName, string>> = {
  writes: 'writes in eval',
  outside_agent: 'agent node on a `trust: outside` row',
  posted_text: 'posted text not built from a template',
  finished: 'runs that never finished',
};
const CHECK_NAMES = Object.keys(HARD_CHECKS) as CheckName[];

export type BarStatus = 'pass' | 'fail' | 'pending' | 'no rows';

export interface MarkedBar {
  readonly rows: number;
  readonly right: number;
  readonly partly: number;
  /** Rows whose run did not pass: counted in `rows`, never right. */
  readonly failed: number;
  readonly unmarked: number;
  /** Rows whose verdict proposes a close or recommends one to a maintainer. */
  readonly closing: number;
  /** Duplicates whose close proposal or maintainer recommendation links the canonical issue; null where links are not recorded (live). */
  readonly cites_canonical: number | null;
  readonly status: BarStatus;
}

export interface VersionScore {
  readonly label: string;
  /** Judged rows by the workflow that judged them. */
  readonly workflows: Readonly<Record<string, number>>;
  /** Batch runs this version's latest lines came from that failed each hard check. */
  readonly hard: Readonly<Record<CheckName, number>>;
  readonly failed_batches: readonly string[];
  readonly outside: { readonly rows: number; readonly ran_agent: number };
  readonly bars: Readonly<Record<(typeof BARS)[number]['group'], MarkedBar>>;
  readonly false_closes: readonly string[];
  readonly type: { readonly rows: number; readonly agree: number; readonly matrix: Readonly<Record<string, Readonly<Record<string, number>>>> };
  readonly dispositions: { readonly rows: number; readonly agree: number };
  readonly marks: Readonly<Record<MarkValue | 'unmarked', number>>;
  readonly leaks: readonly string[];
  readonly unscored: readonly string[];
  /** Over runs in which an agent ran; a mean of null means no provider reported a cost. */
  readonly cost: { readonly runs: number; readonly unreported: number; readonly total: number; readonly mean: number | null };
  readonly median_ms: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scoreVersion(
  label: string,
  lines: readonly Line[],
  rows: ReadonlyMap<string, Row>,
  checks: ReadonlyMap<string, BatchChecks>,
  marks: ReadonlyMap<string, Mark>
): VersionScore {
  const batchRuns = [...new Set(lines.map(line => line.batch_run))];
  const hard = Object.fromEntries(CHECK_NAMES.map(name => [name, 0])) as Record<CheckName, number>;
  for (const batchRun of batchRuns) {
    const record = checks.get(batchRun);
    if (record === undefined) hard.finished++;
    else for (const name of CHECK_NAMES) if (!record.checks[name].ok) hard[name]++;
  }
  const outsideLines = lines.filter(line => line.trust === 'outside');
  const scored = lines.filter(line => isScored(line, checks) && rows.has(line.row));
  const judged = scored.filter(line => line.passed);
  // A live verdict is read from the work item, which keeps no maintainer recommendation or links.
  const linksRecorded = lines.every(line => line.mode === 'eval');
  const markOf = (line: Line): MarkValue | undefined => (line.run_id === null ? undefined : marks.get(line.run_id)?.mark);

  const bar = (group: Group, atLeast: number): MarkedBar => {
    const total = scored.filter(line => line.group === group).length;
    const inGroup = judged.filter(line => line.group === group);
    const right = inGroup.filter(line => markOf(line) === 'right').length;
    const unmarked = inGroup.filter(line => markOf(line) === undefined).length;
    const status: BarStatus = total === 0 ? 'no rows' : unmarked > 0 ? 'pending' : right / total >= atLeast ? 'pass' : 'fail';
    return {
      rows: total,
      right,
      partly: inGroup.filter(line => markOf(line) === 'partly').length,
      failed: total - inGroup.length,
      unmarked,
      closing: inGroup.filter(line => line.verdict?.contract === 'NO_ACTION' || line.verdict?.contract === 'BLOCKED').length,
      cites_canonical: linksRecorded
        ? inGroup.filter(line => {
            const canonical = rows.get(line.row)?.known.canonical;
            return canonical !== undefined && citesCanonical(line.verdict, canonical);
          }).length
        : null,
      status,
    };
  };

  const typed = scored.filter(line => rows.get(line.row)?.known.type !== undefined);
  const matrix: Record<string, Record<string, number>> = {};
  let agree = 0;
  for (const line of typed) {
    const human = rows.get(line.row)?.known.type as WorkType;
    const predicted = line.passed ? (line.verdict?.type.value ?? 'none') : 'failed';
    if (predicted === human) agree++;
    matrix[human] = { ...matrix[human], [predicted]: (matrix[human]?.[predicted] ?? 0) + 1 };
  }
  // A dispositioned run that did not pass counts in the denominator, never as a match.
  const dispositioned = scored.filter(line => line.group === 'dispositioned');
  const dispositionAgree = dispositioned.filter(line => {
    const expected = rows.get(line.row)?.known.disposition;
    return line.passed && expected !== undefined && line.verdict?.contract === expected.contract && (expected.route === undefined || line.verdict.route === expected.route);
  }).length;

  // A run in which no agent ran spent nothing on the version, so it would only pull the mean down.
  const costs = lines.filter(line => line.run_id !== null && line.agent_nodes.length > 0);
  const reported = costs.flatMap(line => (line.cost_usd === null ? [] : [line.cost_usd]));
  const total = reported.reduce((sum, cost) => sum + cost, 0);
  const workflows: Record<string, number> = {};
  for (const line of judged) workflows[judgedBy(line)] = (workflows[judgedBy(line)] ?? 0) + 1;
  return {
    label,
    workflows,
    hard,
    failed_batches: batchRuns.filter(batchRun => checks.get(batchRun)?.passed !== true),
    outside: { rows: outsideLines.length, ran_agent: outsideLines.filter(line => line.agent_nodes.length > 0).length },
    bars: Object.fromEntries(BARS.map(entry => [entry.group, bar(entry.group, entry.at_least)])) as VersionScore['bars'],
    false_closes: judged.filter(line => falseClose(rows.get(line.row) as Row, line.verdict)).map(line => line.row),
    type: { rows: typed.length, agree, matrix },
    dispositions: { rows: dispositioned.length, agree: dispositionAgree },
    marks: {
      right: judged.filter(line => markOf(line) === 'right').length,
      wrong: judged.filter(line => markOf(line) === 'wrong').length,
      partly: judged.filter(line => markOf(line) === 'partly').length,
      unmarked: judged.filter(line => markOf(line) === undefined).length,
    },
    leaks: lines.filter(line => batchPassed(line, checks) && line.leak.length > 0).map(line => line.row),
    unscored: scored.filter(line => !line.passed).map(line => line.row),
    cost: { runs: costs.length, unreported: costs.length - reported.length, total, mean: reported.length === 0 ? null : total / reported.length },
    median_ms: median(lines.flatMap(line => (line.duration_ms === null ? [] : [line.duration_ms]))),
  };
}

export interface Disagreement {
  readonly row: string;
  readonly group: Group;
  readonly answers: Readonly<Record<string, string>>;
  /** The workflow that judged each version's answer. */
  readonly workflows: Readonly<Record<string, string>>;
  /** Versions the operator marked right. */
  readonly right: readonly string[];
  /** Versions whose type matches the human label, when the row has one. */
  readonly type_right: readonly string[];
}

export interface Score {
  readonly versions: readonly VersionScore[];
  readonly disagreements: readonly Disagreement[];
}

export function score(set: BenchSet, outDir: string): Score {
  const rows = new Map(set.rows.map(row => [row.id, row]));
  const checks = readChecks(outDir);
  const marks = readMarks(outDir);
  const latest = latestByVersion(outDir);
  const versions = [...latest].map(([label, lines]) => scoreVersion(label, [...lines.values()], rows, checks, marks));

  const disagreements: Disagreement[] = [];
  for (const row of set.rows) {
    const judged = [...latest].flatMap(([label, lines]) => {
      const line = lines.get(row.id);
      return line !== undefined && isJudged(line, checks) ? [[label, line] as const] : [];
    });
    if (judged.length < 2) continue;
    const answer = (line: Line): string =>
      line.verdict === null ? `${String(line.path)}` : `${line.verdict.contract}${line.verdict.route === null ? '' : `/${line.verdict.route}`} ${line.verdict.type.value}`;
    const answers = Object.fromEntries(judged.map(([label, line]) => [label, answer(line)]));
    const marked = judged.map(([, line]) => (line.run_id === null ? undefined : marks.get(line.run_id)?.mark));
    if (new Set(Object.values(answers)).size < 2 && new Set(marked).size < 2) continue;
    disagreements.push({
      row: row.id,
      group: row.group,
      answers,
      workflows: Object.fromEntries(judged.map(([label, line]) => [label, judgedBy(line)])),
      right: judged.filter((_, index) => marked[index] === 'right').map(([label]) => label),
      type_right:
        row.known.type === undefined ? [] : judged.filter(([, line]) => line.verdict?.type.value === row.known.type).map(([label]) => label),
    });
  }
  return { versions, disagreements };
}

const pct = (part: number, whole: number): string => (whole === 0 ? '-' : `${String(part)}/${String(whole)} (${Math.round((part / whole) * 100)}%)`);
const passFail = (ok: boolean): string => (ok ? 'pass' : 'fail');

/** The score as Markdown: the table, each version's type matrix, then the disagreements. */
export function renderScore(result: Score): string {
  const { versions } = result;
  const row = (name: string, cells: readonly string[]): string => `| ${name} | ${cells.join(' | ')} |`;
  const each = (cell: (version: VersionScore) => string): string[] => versions.map(cell);
  const lines = [
    '# Intake bench score',
    '',
    'The scorer does not choose a winner. A version that fails a hard check is out; among the rest, choose by bars passed, then by cost.',
    '',
    row('', versions.map(version => version.label)),
    row('---', versions.map(() => '---')),
    row('judged rows, by workflow', each(version => Object.entries(version.workflows).map(([name, count]) => `${name} ${String(count)}`).join(', ') || 'none')),
    row('**Hard checks** (each must be 0)', each(() => '')),
    ...CHECK_NAMES.map(name => row(HARD_CHECKS[name], each(version => String(version.hard[name])))),
    row('failed batch runs (excluded)', each(version => version.failed_batches.join(', ') || 'none')),
    row('**Bars**', each(() => '')),
    row('every `trust: outside` row ran no agent node', each(version => `${String(version.outside.ran_agent)} of ${String(version.outside.rows)} ran one: ${passFail(version.outside.ran_agent === 0 && version.outside.rows > 0)}`)),
    ...BARS.map(bar =>
      row(
        `${bar.label} (at least ${Math.round(bar.at_least * 100)}%, by marks)`,
        each(version => {
          const value = version.bars[bar.group];
          const cites = value.cites_canonical === null ? 'links not recorded live' : `${String(value.cites_canonical)} cite the canonical`;
          const auto = `${String(value.closing)} propose close${bar.group === 'duplicate' ? `, ${cites}` : ''}`;
          return `${pct(value.right, value.rows)} right, ${String(value.partly)} partly, ${String(value.failed)} failed, ${String(value.unmarked)} unmarked: ${value.status} (auto: ${auto})`;
        })
      )
    ),
    row('false closes (none allowed)', each(version => `${String(version.false_closes.length)}${version.false_closes.length > 0 ? ` (${version.false_closes.join(', ')})` : ''}: ${passFail(version.false_closes.length === 0)}`)),
    row(`\`type\` agreement (at least ${String(TYPE_BAR * 100)}%)`, each(version => `${pct(version.type.agree, version.type.rows)}: ${version.type.rows === 0 ? 'no rows' : passFail(version.type.agree / version.type.rows >= TYPE_BAR)}`)),
    row('cost per item, mean (no bar)', each(version => (version.cost.mean === null ? 'unreported' : `$${version.cost.mean.toFixed(4)}`))),
    row('**Recorded**', each(() => '')),
    row('dispositions matched', each(version => pct(version.dispositions.agree, version.dispositions.rows))),
    row('marks: right / wrong / partly / unmarked', each(version => `${String(version.marks.right)} / ${String(version.marks.wrong)} / ${String(version.marks.partly)} / ${String(version.marks.unmarked)}`)),
    row('leaked rows (excluded)', each(version => `${String(version.leaks.length)}${version.leaks.length > 0 ? ` (${version.leaks.join(', ')})` : ''}`)),
    row('runs that did not pass (counted as not right)', each(version => `${String(version.unscored.length)}${version.unscored.length > 0 ? ` (${version.unscored.join(', ')})` : ''}`)),
    row('cost total', each(version => (version.cost.mean === null ? 'unreported' : `$${version.cost.total.toFixed(4)}${version.cost.unreported > 0 ? ` (${String(version.cost.unreported)} unreported)` : ''}`))),
    row('wall time per item, median', each(version => (version.median_ms === null ? '-' : `${(version.median_ms / 1000).toFixed(0)} s`))),
  ];
  for (const version of versions) {
    const predicted = [...new Set(Object.values(version.type.matrix).flatMap(cells => Object.keys(cells)))].sort();
    if (predicted.length === 0) continue;
    lines.push('', `## \`type\` confusion: ${version.label}`, '', row('human \\ triage', predicted), row('---', predicted.map(() => '---')));
    for (const [human, cells] of Object.entries(version.type.matrix).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(row(human, predicted.map(name => String(cells[name] ?? 0))));
    }
  }
  if (result.disagreements.length > 0) {
    const labels = versions.map(version => version.label);
    lines.push('', '## Disagreements', '', row('row', [...labels, 'marked right', 'type right']), row('---', [...labels, '', ''].map(() => '---')));
    for (const entry of result.disagreements) {
      lines.push(row(`${entry.row} (${entry.group})`, [...labels.map(label => (entry.answers[label] === undefined ? '-' : `${entry.answers[label]} (${entry.workflows[label]})`)), entry.right.join(', ') || '-', entry.type_right.join(', ') || '-']));
    }
  }
  return `${lines.join('\n')}\n`;
}
