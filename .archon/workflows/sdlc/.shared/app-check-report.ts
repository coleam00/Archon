/**
 * The black-box app check's report, read as data.
 *
 * The app check is an agent; what it claims is text. Two deterministic steps read that
 * text after it: one checks that every line's evidence exists and was really looked at,
 * and the merge gate checks that nothing the report says is wrong reaches the default
 * branch without a decision. Both read it through this one parser, so they agree on
 * what a line says.
 *
 * Line shapes (the app check's prompt documents the same ones):
 *
 *   APP CHECK <pull request URL> at <commit> [merged with <branch> at <commit>]
 *   C1 PASS|FAIL|INCOMPLETE  <criterion>  <observation>  [evidence: <path>, <path>]
 *   H1 PASS|FAIL|FAIL (pre-existing: <citation>)|INCOMPLETE  <scenario id>  <symptom>  [evidence: ...]
 *   P1 OK|SURPRISE  <state> / <action>: <what happened>  [evidence: ...]
 *   D1 NEW|PRE-EXISTING (<citation>)|QUESTION  <what a user sees>  [evidence: ...]
 *   DEFECTS SEEN: none
 *   Overall: PASS | FAIL (<reason>)
 *
 * A line re-used from an earlier check says `(carried from <commit>)` instead of citing
 * new evidence.
 */

export type LineKind = 'C' | 'H' | 'P' | 'D';

export interface ReportLine {
  /** `C1`, `H2`, `P3`, `D1`. */
  readonly id: string;
  readonly kind: LineKind;
  /** The verdict word, upper-cased: PASS, FAIL, INCOMPLETE, OK, SURPRISE, NEW, PRE-EXISTING. */
  readonly verdict: string;
  /** What followed the verdict word in parentheses, if anything (a citation or a reason). */
  readonly qualifier: string;
  readonly text: string;
  readonly evidence: string[];
  /** The commit an earlier check observed this line at, when it was carried over. */
  readonly carriedFrom: string | null;
}

export interface AppCheckReport {
  readonly noPr: boolean;
  readonly pr: string;
  readonly commit: string;
  readonly overall: 'PASS' | 'FAIL' | null;
  readonly defectsNone: boolean;
  readonly lines: ReportLine[];
}

const LINE = /^\s*([CHPD])(\d+)\s+([A-Za-z-]+)(?:\s*\(([^)]*)\))?\s*(.*)$/;
const EVIDENCE = /\[evidence:\s*([^\]]*)\]\s*$/i;
const CARRIED = /\(carried from ([0-9a-f]{7,40})\)/i;

export function parseAppCheck(report: string): AppCheckReport {
  const textLines = report.split(/\r?\n/);
  const noPr = textLines.some(line => /^\s*NO PR\b/.test(line));
  let pr = '';
  let commit = '';
  let overall: AppCheckReport['overall'] = null;
  let defectsNone = false;
  const lines: ReportLine[] = [];
  for (const raw of textLines) {
    const header = /^\s*APP CHECK\s+(\S+)\s+at\s+([0-9a-f]{7,40})/i.exec(raw);
    if (header !== null) {
      pr = header[1];
      commit = header[2];
      continue;
    }
    const total = /^\s*Overall:\s*(PASS|FAIL)\b/i.exec(raw);
    if (total !== null) {
      overall = total[1].toUpperCase() as 'PASS' | 'FAIL';
      continue;
    }
    if (/^\s*DEFECTS SEEN:\s*none\b/i.test(raw)) {
      defectsNone = true;
      continue;
    }
    const match = LINE.exec(raw);
    if (match === null) continue;
    const evidence = EVIDENCE.exec(match[5]);
    lines.push({
      id: `${match[1]}${match[2]}`,
      kind: match[1] as LineKind,
      verdict: match[3].toUpperCase(),
      qualifier: (match[4] ?? '').trim(),
      text: match[5].replace(EVIDENCE, '').trim(),
      evidence:
        evidence === null
          ? []
          : evidence[1]
              .split(',')
              .map(path => path.trim().replace(/^`|`$/g, ''))
              .filter(path => path !== ''),
      carriedFrom: CARRIED.exec(raw)?.[1] ?? null,
    });
  }
  return { noPr, pr, commit, overall, defectsNone, lines };
}

/** A line that says something is wrong: a failed or unfinished check, a surprise, or a defect. */
export function isAdverse(line: ReportLine): boolean {
  if (line.kind === 'D') return true;
  if (line.kind === 'P') return line.verdict !== 'OK';
  return line.verdict !== 'PASS';
}

/** A holdout failure the default branch already has, with the citation that shows it. */
export function isProvenPreExisting(line: ReportLine): boolean {
  if (line.kind === 'H') return line.verdict === 'FAIL' && /^pre-existing\s*:\s*\S/i.test(line.qualifier);
  if (line.kind === 'D') return line.verdict === 'PRE-EXISTING' && line.qualifier.trim() !== '';
  return false;
}

/**
 * A line that makes `Overall: PASS` false: a criterion not passed, a holdout failed or left
 * unfinished without proof the default branch fails it too, or a defect not proven to be on
 * the default branch already. A probe's surprise counts through the defect line it names.
 */
export function blocksPass(line: ReportLine): boolean {
  if (line.kind === 'P') return false;
  if (line.kind === 'C') return line.verdict !== 'PASS';
  if (isQuestion(line)) return false;
  return !(line.verdict === 'PASS' && line.kind === 'H') && !isProvenPreExisting(line);
}

/**
 * Something the app check saw and is not sure is a defect. It does not fail the check, but
 * it is never dropped: the reviewer must decide it (an issue, or accepted with a reason).
 */
export function isQuestion(line: ReportLine): boolean {
  return line.kind === 'D' && line.verdict === 'QUESTION';
}

/** Image evidence must have been opened, not just written. */
export function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}
