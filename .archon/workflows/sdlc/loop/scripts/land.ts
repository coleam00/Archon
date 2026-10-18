/**
 * The merge gate: merge what the reviewer accepted, only when the record supports it.
 *
 * Left to merge by itself, the reviewer merged over defects the app check had seen, over a
 * shipping pipeline whose review step had crashed, and onto a default branch that had moved
 * since anything was tested. So the reviewer decides `merge` and names the commit, and this
 * step, with no model, merges only when the record rules in `.shared/merge-gate.ts` hold and
 * the pull request's head is the reviewed commit and contains the current default branch.
 * A refusal is posted as `Loop review: not merged`, so the next lap continues with the
 * reasons in hand. The forge is GitHub, through `gh`, like the rest of this loop.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { artifactsDir, emit, text, trimmed } from '../../.shared/io.ts';
import { CLOCK_SLACK_MS, parseDispositions, readAppCheck, recordRefusals, shipFailuresInLog } from '../../.shared/merge-gate.ts';

const prUrl = trimmed(process.env.INPUTS_PR);
const sha = trimmed(process.env.INPUTS_SHA);
const route = trimmed(process.env.INPUTS_ROUTE);
const target = trimmed(process.env.INPUTS_TARGET);
const delivers = trimmed(process.env.INPUTS_DELIVERS);
const evidenceProblems = text(process.env.INPUTS_EVIDENCE_PROBLEMS).split('\n').filter(line => line.trim() !== '');
const reviewStarted = Number(trimmed(process.env.INPUTS_REVIEW_STARTED)) || 0;
const logPath = join(trimmed(process.env.LOG_DIR), `${trimmed(process.env.WORKFLOW_ID)}.jsonl`);
const artifacts = artifactsDir();

function run(cmd: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const refusals = recordRefusals({
  report: readAppCheck(text(process.env.INPUTS_REPORT)),
  evidenceProblems,
  dispositions: parseDispositions(text(process.env.INPUTS_DISPOSITIONS)),
  shipFailures: existsSync(logPath) ? shipFailuresInLog(readFileSync(logPath, 'utf8')) : [],
  freshFile: ref => {
    const path = ref === '' ? '' : isAbsolute(ref) ? ref : join(artifacts, ref);
    return path !== '' && existsSync(path) && statSync(path).mtimeMs + CLOCK_SLACK_MS >= reviewStarted;
  },
  issueExists: ref => {
    const number = /^#?(\d+)$/.exec(ref)?.[1];
    return number !== undefined && run(['gh', 'issue', 'view', number, '--json', 'number']).code === 0;
  },
});

let branch = '';
let alreadyMerged = false;
const view = run(['gh', 'pr', 'view', prUrl, '--json', 'number,state,headRefOid,headRefName,baseRefName']);
if (view.code !== 0) {
  refusals.push(`could not read the pull request: ${view.err.trim().slice(0, 200)}`);
} else {
  const pr = JSON.parse(view.out) as { number: number; state: string; headRefOid: string; headRefName: string; baseRefName: string };
  branch = pr.headRefName;
  if (pr.state === 'MERGED') alreadyMerged = true;
  else if (pr.state !== 'OPEN') refusals.push(`the pull request is ${pr.state.toLowerCase()}`);
  else if (pr.headRefOid !== sha) {
    refusals.push(`its head is ${pr.headRefOid.slice(0, 12)}, not the reviewed ${sha.slice(0, 12) || '(none named)'}`);
  } else {
    run(['git', 'fetch', '--quiet', 'origin', pr.baseRefName, `+refs/pull/${pr.number}/head:refs/remotes/origin/loop-land-${pr.number}`]);
    if (run(['git', 'merge-base', '--is-ancestor', `origin/${pr.baseRefName}`, sha]).code !== 0) {
      refusals.push(`${pr.baseRefName} has moved past what was tested; the next lap re-gates on the merge`);
    }
  }
}

const comment = (body: string): void => {
  if (prUrl !== '') run(['gh', 'pr', 'comment', prUrl, '--body', body]);
};
const list = refusals.map(r => `- ${r}`).join('\n');

if (alreadyMerged) {
  comment(`Loop review: merged (route: ${route}) outside the merge gate. The gate's own checks, for the record:\n\n${list || '- all held'}`);
  emit({ outcome: 'merged', reason: 'the pull request was already merged when the gate ran' });
} else if (refusals.length > 0) {
  comment(`Loop review: not merged (route: ${route}). The merge gate refused the reviewer's merge:\n\n${list}\n\nThe next lap continues this pull request.`);
  emit({ outcome: 'refused', reason: refusals.join('; ') });
} else {
  const merged = run(['gh', 'pr', 'merge', prUrl, '--squash', '--match-head-commit', sha]);
  if (merged.code !== 0) {
    const why = merged.err.trim().slice(0, 300);
    comment(`Loop review: not merged (route: ${route}). \`gh pr merge\` refused: ${why}`);
    emit({ outcome: 'refused', reason: `gh pr merge failed: ${why}` });
  } else {
    if (branch !== '') run(['git', 'push', '--quiet', 'origin', '--delete', branch]);
    const issue = /\/issues\/(\d+)\/?$/.exec(target)?.[1];
    if (issue !== undefined && delivers === 'all') {
      const state = run(['gh', 'issue', 'view', issue, '--json', 'state', '--jq', '.state']).out.trim();
      if (state === 'OPEN') run(['gh', 'issue', 'close', issue, '--comment', `Delivered by ${prUrl}.`]);
    }
    comment(`Loop review: merged (route: ${route}) at ${sha} by the merge gate, after the review above.`);
    emit({ outcome: 'merged', reason: `merged ${sha}` });
  }
}
