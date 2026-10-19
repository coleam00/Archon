/**
 * Check that the app check's report stands on evidence it really produced.
 *
 * The app check is an agent, and an agent can write a PASS line for a run it never made or
 * cite a screenshot it never looked at. With no model, this checks every line of its
 * structured report: it cites evidence (unless carried from an earlier commit), each cited
 * file exists and was written after the check began, each cited image was opened by the app
 * check, a default-branch failure names a file that shows it, a carried line comes from an
 * earlier commit of the tested head, and Overall is not PASS over a line that fails it. The rules live in
 * `.shared/merge-gate.ts`; the reviewer and the merge gate both read this verdict.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { artifactsDir, emit, text, trimmed } from '../../.shared/io.ts';
import { evidenceProblems, filesReadInLog, readAppCheck } from '../../.shared/merge-gate.ts';

const report = readAppCheck(text(process.env.INPUTS_REPORT));
const started = Number(trimmed(process.env.INPUTS_STARTED)) || 0;
const logPath = join(trimmed(process.env.LOG_DIR), `${trimmed(process.env.WORKFLOW_ID)}.jsonl`);
const artifacts = artifactsDir();

/** Comparable spelling of a path: separators, and on Windows case and the Git Bash drive form (/c/...). */
const key = (path: string): string => {
  const value = normalize(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.replace(/^\/([a-z])\//i, '$1:/').toLowerCase() : value;
};

const resolve = (cited: string): string => (isAbsolute(cited) ? cited : join(artifacts, cited));

// Without the run log nothing can say whether an image was opened, so that rule is skipped.
const opened = existsSync(logPath) ? filesReadInLog(readFileSync(logPath, 'utf8'), 'check-app', key) : null;

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

const problems = evidenceProblems(
  report,
  started,
  cited => {
    const path = resolve(cited);
    if (!existsSync(path)) return { exists: false, mtimeMs: 0, opened: null };
    return { exists: true, mtimeMs: statSync(path).mtimeMs, opened: opened === null ? null : opened.has(key(path)) };
  },
  {
    // Any word of the citation that is a file on disk, quotes and trailing punctuation aside.
    namesFile: citation =>
      citation
        .split(/[\s,;()"'`]+/)
        .map(word => word.replace(/[.:]+$/, ''))
        .some(word => /[\\/.]/.test(word) && isFile(resolve(word))),
    earlierCommit: sha =>
      report.head !== '' &&
      Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, report.head], { stdout: 'ignore', stderr: 'ignore' })
        .exitCode === 0,
  }
);

emit({
  ok: problems.length === 0 ? 'true' : 'false',
  problems: problems.join('\n'),
  overall: report.pr === '' ? 'NO PR' : report.overall || 'MISSING',
  // The review starts after this step: evidence the reviewer adds is newer than this.
  checked_at: String(Date.now()),
});
