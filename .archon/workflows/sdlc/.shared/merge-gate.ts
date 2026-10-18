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
    return { pr: str(raw.pr), overall: str(raw.overall), lines };
  } catch {
    return { pr: '(unreadable report)', overall: '', lines: [] };
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

/** Why the report does not stand on its own evidence; empty when it does. */
export function evidenceProblems(report: AppCheck, startedMs: number, look: (path: string) => CitedFile): string[] {
  if (report.pr === '') return [];
  const problems: string[] = report.lines.length === 0 ? ['the report has no lines'] : [];
  for (const line of report.lines) {
    if (line.carried_from !== '' && line.kind !== 'defect') continue;
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

export interface GateFacts {
  readonly report: AppCheck;
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
  const unresolved = facts.evidenceProblems.filter(problem => {
    const id = /^([A-Z]+\d+)\b/.exec(problem)?.[1];
    return id === undefined || !rechecked(id);
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
  for (const failed of facts.shipFailures) refusals.push(`the shipping pipeline's ${failed} failed`);
  return refusals;
}

// The two readers below parse Archon's run log ($LOG_DIR/<run>.jsonl), an engine format and not
// a pack contract; loop-gates.test.ts pins the lines they read. `ship__` is the prefix the engine
// gives the nodes this loop's `ship` include expands to.

/** Failed shipping-pipeline nodes recorded in a run's event log. */
export function shipFailuresInLog(log: string): string[] {
  return eventsOf(log)
    .filter(e => (e.type === 'node_error' || e.type === 'node_failed') && (e.step ?? '').startsWith('ship__'))
    .map(e => `${e.step}${e.error ? `: ${e.error.slice(0, 200)}` : ''}`);
}

/** Files a node opened with its Read tool, from a run's event log. */
export function filesReadInLog(log: string, step: string, key: (path: string) => string): Set<string> {
  const opened = eventsOf(log)
    .filter(e => e.step === step && e.event?.name === 'Read' && typeof e.event.rawInput?.file_path === 'string')
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
