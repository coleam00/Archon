/**
 * The two record checks that stand between an agent's report and the default branch,
 * as pure functions over what the scripts read from disk, the run log and the forge.
 * `loop/scripts/evidence.ts` and `loop/scripts/land.ts` do the reading; these decide.
 */

import { blocksPass, isAdverse, isImage, isProvenPreExisting, isQuestion, type AppCheckReport } from './app-check-report.ts';

export interface CitedFile {
  readonly exists: boolean;
  /** Last write, in milliseconds since the epoch. */
  readonly mtimeMs: number;
  /** The app check opened it with its Read tool. */
  readonly opened: boolean;
}

/** Slack for clocks and file systems that round modification times. */
const CLOCK_SLACK_MS = 2000;

/**
 * Why an app-check report does not stand on its own evidence; empty when it does.
 * `look` resolves a cited path to what is on disk and in the run log.
 */
export function evidenceProblems(
  report: AppCheckReport,
  startedMs: number,
  look: (cited: string) => CitedFile
): string[] {
  if (report.noPr) return [];
  const problems: string[] = [];
  if (report.lines.length === 0) problems.push('the report has no check lines');
  if (report.overall === null) problems.push('the report has no Overall line');
  for (const line of report.lines) {
    if (line.carriedFrom !== null && line.kind !== 'D') continue;
    if (line.evidence.length === 0) {
      problems.push(`${line.id} cites no evidence`);
      continue;
    }
    for (const cited of line.evidence) {
      const file = look(cited);
      if (!file.exists) {
        problems.push(`${line.id} cites ${cited}, which does not exist`);
        continue;
      }
      if (file.mtimeMs + CLOCK_SLACK_MS < startedMs) {
        problems.push(`${line.id} cites ${cited}, which was written before this check began`);
      }
      if (isImage(cited) && !file.opened) {
        problems.push(`${line.id} cites the image ${cited}, which the app check never opened`);
      }
    }
  }
  const blocking = report.lines.filter(blocksPass).map(line => line.id);
  if (report.overall === 'PASS' && blocking.length > 0) {
    problems.push(`Overall says PASS over ${blocking.join(', ')}`);
  }
  const defects = new Set(report.lines.filter(line => line.kind === 'D').map(line => line.id));
  for (const probe of report.lines.filter(line => line.kind === 'P' && isAdverse(line))) {
    if (!defects.has(probe.qualifier.trim().toUpperCase())) {
      problems.push(`${probe.id} is a surprise with no DEFECTS SEEN line (write it as SURPRISE (D<n>))`);
    }
  }
  if (!report.defectsNone && defects.size === 0) {
    problems.push('the report has no DEFECTS SEEN section (write "DEFECTS SEEN: none" when there are none)');
  }
  return problems;
}

export interface Disposition {
  readonly line: string;
  readonly action: string;
  readonly ref: string;
}

/** The reviewer's dispositions, keyed by line id; anything malformed is dropped. */
export function parseDispositions(textValue: string): Map<string, Disposition> {
  const found = new Map<string, Disposition>();
  let raw: unknown = [];
  try {
    raw = textValue.trim() === '' ? [] : JSON.parse(textValue);
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) return found;
  for (const entry of raw as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== 'object') continue;
    // A reviewer may quote the whole report line; the id it starts with is what counts.
    const quoted = typeof entry.line === 'string' ? entry.line.trim().toUpperCase() : '';
    const line = /^([CHPD]\d+)(?![0-9])/.exec(quoted)?.[1] ?? '';
    if (line === '') continue;
    found.set(line, {
      line,
      action: typeof entry.action === 'string' ? entry.action.trim() : '',
      ref: typeof entry.ref === 'string' ? entry.ref.trim() : '',
    });
  }
  return found;
}

export interface GateFacts {
  readonly report: AppCheckReport;
  readonly evidenceOk: boolean;
  readonly evidenceProblems: string;
  readonly dispositions: Map<string, Disposition>;
  /** Shipping-pipeline nodes that failed in this run, with their errors. */
  readonly shipFailures: readonly string[];
  /** A file the reviewer wrote during its review. */
  readonly reviewerFile: (ref: string) => boolean;
  readonly issueExists: (ref: string) => boolean;
}

/**
 * Why the record does not support merging; empty when it does. The forge-side checks
 * (head unchanged, default branch contained) are the caller's: they need the network.
 */
export function recordRefusals(facts: GateFacts): string[] {
  const refusals: string[] = [];
  if (!facts.evidenceOk) {
    refusals.push(
      `the app check's report did not hold up: ${facts.evidenceProblems.replace(/\n/g, '; ') || 'no evidence verdict'}`
    );
  }
  if (facts.report.noPr) refusals.push('the app check found no pull request to test');
  for (const line of facts.report.lines) {
    const disposition = facts.dispositions.get(line.id);
    if (blocksPass(line)) {
      const [file = '', ...rest] = (disposition?.ref ?? '').split(/\s+/);
      if (disposition?.action === 'rechecked' && facts.reviewerFile(file)) continue;
      if (disposition?.action === 'pre-existing' && facts.reviewerFile(file)) {
        const issue = rest.find(token => /^#\d+$/.test(token));
        if (issue === undefined || !facts.issueExists(issue)) {
          refusals.push(`${line.id} is pre-existing by the reviewer's run, but no issue that exists tracks it`);
        }
        continue;
      }
      refusals.push(`${line.id} (${line.verdict}) has no re-check or default-branch proof the reviewer wrote`);
    } else if (isQuestion(line)) {
      const decided =
        (disposition?.action === 'issue' && facts.issueExists(disposition.ref)) ||
        (disposition?.action === 'accepted' && (disposition.ref ?? '').trim().length >= 12);
      if (!decided) {
        refusals.push(`${line.id} is an open question the review did not decide (an issue, or accepted with a reason)`);
      }
    } else if (isProvenPreExisting(line)) {
      // Whatever the reviewer called it, what counts is an existing issue that tracks it.
      const issue = (disposition?.ref ?? '').split(/\s+/).find(token => /^#\d+$/.test(token));
      if (issue === undefined || !facts.issueExists(issue)) {
        refusals.push(`${line.id} is a failure the default branch has too, but no issue that exists tracks it`);
      }
    }
  }
  for (const failed of facts.shipFailures) refusals.push(`the shipping pipeline's ${failed} failed`);
  return refusals;
}

/** Failed shipping-pipeline nodes recorded in a run's event log (JSON lines). */
export function shipFailuresInLog(log: string): string[] {
  const failed: string[] = [];
  for (const line of log.split('\n')) {
    if (!line.includes('"node_error"') && !line.includes('"node_failed"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; step?: string; error?: string };
      if ((entry.type === 'node_error' || entry.type === 'node_failed') && entry.step?.startsWith('ship__')) {
        failed.push(`${entry.step}${entry.error ? `: ${entry.error.slice(0, 200)}` : ''}`);
      }
    } catch {
      // A partial last line of a log still being written carries nothing to check.
    }
  }
  return failed;
}

/** Files a node opened with its Read tool, from a run's event log (JSON lines). */
export function filesReadInLog(log: string, step: string, key: (path: string) => string): Set<string> {
  const opened = new Set<string>();
  for (const line of log.split('\n')) {
    if (!line.includes(`"${step}"`) || !line.includes('"Read"')) continue;
    try {
      const entry = JSON.parse(line) as {
        step?: string;
        event?: { type?: string; name?: string; rawInput?: { file_path?: unknown } };
      };
      const path = entry.event?.rawInput?.file_path;
      if (entry.step === step && entry.event?.name === 'Read' && typeof path === 'string') opened.add(key(path));
    } catch {
      // As above.
    }
  }
  return opened;
}
