/**
 * Check that the app check's report stands on evidence it really produced.
 *
 * The app check is an agent, and an agent can write a PASS line for a run it never made or
 * cite a screenshot it never looked at. This step reads its report and, with no model:
 *
 * - every check, holdout, probe and defect line cites at least one evidence file, unless it
 *   says it was carried from an earlier commit;
 * - every cited file exists and was written after the check began;
 * - every cited image was opened by the app check (a Read of that file in this run's log);
 * - `Overall: PASS` is not claimed over a failed or unfinished line or a new defect, every
 *   probe surprise names its defect line, and the report has a DEFECTS SEEN section.
 *
 * Its verdict goes to the reviewer and to the merge gate, which refuses to merge on a report
 * that does not hold up. The rules live in `.shared/merge-gate.ts`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { parseAppCheck } from '../../.shared/app-check-report.ts';
import { artifactsDir, emit, text, trimmed } from '../../.shared/io.ts';
import { evidenceProblems, filesReadInLog } from '../../.shared/merge-gate.ts';

const report = parseAppCheck(text(process.env.INPUTS_REPORT));
const started = Number(trimmed(process.env.INPUTS_STARTED)) || 0;
const runId = trimmed(process.env.WORKFLOW_ID);
const logDir = trimmed(process.env.LOG_DIR);
const artifacts = artifactsDir();

/** Comparable spelling of a path: separators, and case on Windows. */
function key(path: string): string {
  const value = normalize(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

const logPath = join(logDir, `${runId}.jsonl`);
const opened =
  logDir !== '' && runId !== '' && existsSync(logPath)
    ? filesReadInLog(readFileSync(logPath, 'utf8'), 'check-app', key)
    : new Set<string>();

const problems = evidenceProblems(report, started, cited => {
  const path = isAbsolute(cited) ? cited : join(artifacts, cited);
  if (!existsSync(path)) return { exists: false, mtimeMs: 0, opened: false };
  return { exists: true, mtimeMs: statSync(path).mtimeMs, opened: opened.has(key(path)) };
});

emit({
  ok: problems.length === 0 ? 'true' : 'false',
  problems: problems.join('\n'),
  overall: report.noPr ? 'NO PR' : (report.overall ?? 'MISSING'),
  // The review starts after this step: evidence the reviewer adds is newer than this.
  checked_at: String(Date.now()),
});
