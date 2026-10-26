/**
 * The record checks between an agent's report and the default branch, as pure functions.
 * The app check's report is its structured output (`check-app` in archon-loop.yaml), so
 * nothing here reads prose. `loop/scripts/evidence.ts` and `loop/scripts/land.ts` read the
 * disk, the run log and the forge; these decide.
 */

export interface CheckLine {
  readonly id: string;
  readonly kind: 'criterion' | 'holdout' | 'probe' | 'defect';
  /** PASS, FAIL or INCOMPLETE for a criterion or holdout; OK or SURPRISE for a probe; DEFECT or QUESTION. */
  readonly verdict: string;
  readonly text: string;
  readonly evidence: readonly string[];
  /** The proof that the default branch fails the same way (a baseline row or a default-branch run). */
  readonly pre_existing: string;
  /** For a probe's SURPRISE, the id of the defect line it found. */
  readonly defect: string;
  /** The commit an earlier check observed this line at, when it was carried over. */
  readonly carried_from: string;
}

export interface AppCheck {
  readonly pr: string;
  /** The pull request head the check tested, and its merge with the default branch. */
  readonly head: string;
  readonly merged_with: string;
  readonly overall: string;
  readonly lines: readonly CheckLine[];
}

/** A string field of parsed JSON, trimmed; anything else is empty. */
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function readAppCheck(json: string): AppCheck {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const lines = (Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : []).map(line => ({
      id: str(line.id).toUpperCase(),
      kind: (str(line.kind) || 'defect') as CheckLine['kind'],
      verdict: str(line.verdict).toUpperCase(),
      text: str(line.text),
      evidence: (Array.isArray(line.evidence) ? line.evidence : []).map(str).filter(path => path !== ''),
      pre_existing: str(line.pre_existing),
      defect: str(line.defect).toUpperCase(),
      carried_from: str(line.carried_from),
    }));
    return { pr: str(raw.pr), head: str(raw.head), merged_with: str(raw.merged_with), overall: str(raw.overall), lines };
  } catch {
    return { pr: '(unreadable report)', head: '', merged_with: '', overall: '', lines: [] };
  }
}

export const isQuestion = (line: CheckLine): boolean => line.kind === 'defect' && line.verdict === 'QUESTION';

const failure = (line: CheckLine): boolean =>
  (line.kind === 'holdout' && line.verdict !== 'PASS') || (line.kind === 'defect' && !isQuestion(line));

/** A failure the default branch has too, with its proof: not this change's, but an issue must track it. */
export const isPreExisting = (line: CheckLine): boolean => failure(line) && line.pre_existing !== '';

/**
 * A line that makes `Overall: PASS` false. A criterion of the work item is this change's to
 * meet whatever the default branch does, so it is never pre-existing. A probe counts through
 * the defect line it names.
 */
export function blocksPass(line: CheckLine): boolean {
  if (line.kind === 'criterion') return line.verdict !== 'PASS';
  return failure(line) && line.pre_existing === '';
}

export const isImage = (path: string): boolean => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);

export interface CitedFile {
  readonly exists: boolean;
  readonly mtimeMs: number;
  /** The app check opened it with its Read tool; null when the run log cannot say. */
  readonly opened: boolean | null;
}

/** Slack for clocks and file systems that round modification times. */
export const CLOCK_SLACK_MS = 2000;

export interface Proofs {
  /** The text names a file that exists (a default-branch run, or the holdout baseline). */
  readonly namesFile: (text: string) => boolean;
  /** The commit is an earlier commit of the tested head. */
  readonly earlierCommit: (sha: string) => boolean;
}

/** Why the report does not stand on its own evidence; empty when it does. */
export function evidenceProblems(
  report: AppCheck,
  startedMs: number,
  look: (path: string) => CitedFile,
  proofs: Proofs
): string[] {
  if (report.pr === '') return [];
  const problems: string[] = report.lines.length === 0 ? ['the report has no lines'] : [];
  for (const line of report.lines) {
    if (line.pre_existing !== '' && !proofs.namesFile(line.pre_existing)) {
      problems.push(`${line.id} says the default branch fails the same way but names no file that shows it`);
    }
    if (line.carried_from !== '' && line.kind !== 'defect') {
      if (!proofs.earlierCommit(line.carried_from)) {
        problems.push(`${line.id} is carried from ${line.carried_from}, which is not an earlier commit of the tested head`);
      }
      continue;
    }
    if (line.evidence.length === 0) problems.push(`${line.id} cites no evidence`);
    for (const path of line.evidence) {
      const file = look(path);
      if (!file.exists) problems.push(`${line.id} cites ${path}, which does not exist`);
      else if (file.mtimeMs + CLOCK_SLACK_MS < startedMs) problems.push(`${line.id} cites ${path}, written before this check began`);
      else if (isImage(path) && file.opened === false) problems.push(`${line.id} cites the image ${path}, which the app check never opened`);
    }
  }
  const blocking = report.lines.filter(blocksPass).map(line => line.id);
  if (report.overall === 'PASS' && blocking.length > 0) problems.push(`Overall says PASS over ${blocking.join(', ')}`);
  const defects = new Set(report.lines.filter(line => line.kind === 'defect').map(line => line.id));
  for (const probe of report.lines.filter(line => line.kind === 'probe' && line.verdict !== 'OK')) {
    if (!defects.has(probe.defect)) problems.push(`${probe.id} is a surprise that names no defect line`);
  }
  return problems;
}

export interface Disposition {
  readonly action: string;
  readonly file: string;
  readonly issue: string;
  readonly reason: string;
}

/** The reviewer's dispositions by line id. A reviewer may quote the whole line; its leading id counts. */
export function parseDispositions(json: string): Map<string, Disposition> {
  const found = new Map<string, Disposition>();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return found;
  }
  for (const entry of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
    const id = /^([A-Za-z]+\d+)(?![0-9])/.exec(str(entry?.line))?.[1]?.toUpperCase();
    if (id === undefined) continue;
    found.set(id, { action: str(entry.action), file: str(entry.file), issue: str(entry.issue), reason: str(entry.reason) });
  }
  return found;
}

/** What `gh issue view N --json state,url` says counts as tracking: an open issue, not a pull request. */
export const isTrackingIssue = (view: { state?: string; url?: string }): boolean =>
  view.state === 'OPEN' && /\/issues\/\d+$/.test(view.url ?? '');

export interface MergeFacts {
  /** Trees (git tree ids) of the commit to merge and of what the app check tested. */
  readonly shaTree: string;
  readonly testedTree: string;
  /** The tree of the tested result merged cleanly with the current default branch; '' on conflict. */
  readonly withBaseTree: string;
  /** Files that merge brings in from the default branch, and the files the pull request changes. */
  readonly fromBase: readonly string[];
  readonly prFiles: readonly string[];
}

/**
 * Why the commit to merge is not what the app check tested; null when it is. A reviewer may merge
 * the default branch in after the check (the gate needs the base in the head). That commit stands
 * on the check only when it is the tested result plus the base's new commits merged cleanly, and
 * none of those commits touches a file of this change; anything else needs a new check.
 */
export function untestedMerge(facts: MergeFacts): string | null {
  if (facts.testedTree === '') return 'the app check did not record what it tested';
  if (facts.shaTree === facts.testedTree) return null;
  if (facts.withBaseTree === '' || facts.shaTree !== facts.withBaseTree) {
    return 'the commit to merge is not what the app check tested (it changed more than a clean merge of the default branch)';
  }
  const shared = facts.fromBase.filter(file => facts.prFiles.includes(file));
  return shared.length > 0
    ? `the default branch changed ${shared.slice(0, 5).join(', ')} since the check, which this change also changes`
    : null;
}

export interface JudgeChange {
  readonly file: string;
  readonly change: string;
  readonly approval: string;
}

/** The reviewer's list of changes to what a check judges; anything malformed is dropped. */
export function parseJudgeChanges(json: string): JudgeChange[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  return (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
    .filter(entry => entry !== null && typeof entry === 'object')
    .map(entry => ({ file: str(entry.file), change: str(entry.change), approval: str(entry.approval) }))
    .filter(entry => entry.file !== '' || entry.change !== '');
}

/** An approval is a link to an issue or a comment on one (the owner's words), never a criterion id. */
export const isApprovalLink = (approval: string): boolean =>
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/\d+(#issuecomment-\d+)?$/.test(approval.trim());

export interface GateFacts {
  readonly report: AppCheck;
  /** Changes to what a check judges, each with the owner's approval or the criterion asking for it. */
  readonly judgeChanges: readonly JudgeChange[];
  readonly evidenceProblems: readonly string[];
  readonly dispositions: Map<string, Disposition>;
  /** Shipping-pipeline nodes that failed in this run. */
  readonly shipFailures: readonly string[];
  /** A file the reviewer wrote during its review. */
  readonly freshFile: (path: string) => boolean;
  readonly issueExists: (ref: string) => boolean;
}

/** Why the record does not support merging; empty when it does. The forge checks are the caller's. */
export function recordRefusals(facts: GateFacts): string[] {
  const disposition = (id: string): Disposition | undefined => facts.dispositions.get(id);
  const rechecked = (id: string): boolean => disposition(id)?.action === 'rechecked' && facts.freshFile(disposition(id)?.file ?? '');
  const tracked = (id: string): boolean => facts.issueExists(disposition(id)?.issue ?? '');
  const refusals: string[] = [];
  // A flagged line stands only on the reviewer's own fresh re-check; a problem with the whole report has none.
  // A question the review decided (filed as an issue, or accepted with a reason) supports nothing
  // the merge relies on, so its evidence does not have to hold (seen live: PR #631 refused on that alone).
  const decidedQuestion = (id: string): boolean => {
    const line = facts.report.lines.find(l => l.id === id);
    const mine = disposition(id);
    return line !== undefined && isQuestion(line) &&
      (tracked(id) || (mine?.action === 'accepted' && mine.reason.length >= 12));
  };
  const unresolved = facts.evidenceProblems.filter(problem => {
    const id = /^([A-Z]+\d+)\b/.exec(problem)?.[1];
    return id === undefined || !(rechecked(id) || decidedQuestion(id));
  });
  if (unresolved.length > 0) refusals.push(`the app check's report did not hold up: ${unresolved.join('; ')}`);
  if (facts.report.pr === '') refusals.push('the app check found no pull request to test');
  for (const line of facts.report.lines) {
    const mine = disposition(line.id);
    if (blocksPass(line)) {
      if (rechecked(line.id)) continue;
      if (line.kind === 'criterion') {
        refusals.push(`${line.id} (${line.verdict}): a criterion of this work item is not met. Deliver it in this pull request, or ask the owner to narrow the work item`);
      } else if (mine?.action === 'pre-existing' && facts.freshFile(mine.file)) {
        if (!tracked(line.id)) refusals.push(`${line.id} is pre-existing by the reviewer's run, but no issue that exists tracks it`);
      } else {
        refusals.push(`${line.id} (${line.verdict}) has no re-check or default-branch proof the reviewer wrote`);
      }
    } else if (isQuestion(line)) {
      if (!tracked(line.id) && !(mine?.action === 'accepted' && mine.reason.length >= 12)) {
        refusals.push(`${line.id} is an open question the review did not decide (an issue, or accepted with a reason)`);
      }
    } else if (isPreExisting(line) && !tracked(line.id)) {
      refusals.push(`${line.id} is a failure the default branch has too, but no issue that exists tracks it`);
    }
  }
  for (const judge of facts.judgeChanges) {
    if (judge.approval === '') {
      refusals.push(`${judge.file || 'a check'} changes what a check judges (${judge.change}) with no approval named`);
    } else if (!isApprovalLink(judge.approval)) {
      // A criterion id is the loop's own wording; only the owner's words, linked, approve a judge change.
      refusals.push(`${judge.file || 'a check'} changes what a check judges (${judge.change}), and its approval (${judge.approval}) is not a link to the owner's words`);
    }
  }
  for (const failed of facts.shipFailures) refusals.push(`the shipping pipeline's ${failed} failed`);
  return refusals;
}

// The two readers below parse Archon's run log ($LOG_DIR/<run>.jsonl), an engine format and not
// a pack contract; loop-gates.test.ts pins the lines they read. `ship__` is the prefix the engine
// gives the nodes this loop's `ship` include expands to.

/** Failed shipping-pipeline nodes recorded in a run's event log. */
export function shipFailuresInLog(log: string): string[] {
  const last = new Map<string, LogEvent>();
  for (const e of eventsOf(log)) {
    const ends = e.type === 'node_error' || e.type === 'node_failed' || e.type === 'node_complete';
    if (ends && (e.step ?? '').startsWith('ship__')) last.set(e.step ?? '', e);
  }
  return [...last.values()]
    .filter(e => e.type !== 'node_complete')
    .map(e => `${e.step}${e.error ? `: ${e.error.slice(0, 200)}` : ''}`);
}

/**
 * Files a node opened with its Read tool, from a run's event log. Null when the log cannot say:
 * the node logged no named tool calls at all, as a Codex node does (its image views are not
 * logged), so a cited image there is neither opened nor unopened (mission control, 2026-10-26).
 */
export function filesReadInLog(log: string, step: string, key: (path: string) => string): Set<string> | null {
  const named = eventsOf(log).filter(e => e.step === step && typeof e.event?.name === 'string');
  if (named.length === 0) return null;
  const opened = named
    .filter(e => e.event?.name === 'Read' && typeof e.event.rawInput?.file_path === 'string')
    .map(e => key(e.event?.rawInput?.file_path as string));
  return new Set(opened);
}

interface LogEvent {
  type?: string;
  step?: string;
  error?: string;
  event?: { name?: string; rawInput?: { file_path?: unknown } };
}

function eventsOf(log: string): LogEvent[] {
  return log.split('\n').flatMap(line => {
    try {
      return line.trim() === '' ? [] : [JSON.parse(line) as LogEvent];
    } catch {
      return []; // the partial last line of a log still being written
    }
  });
}
