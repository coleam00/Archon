/**
 * The merge gate: merge what the reviewer accepted, only when the record supports it.
 *
 * Left to merge by itself, the reviewer merged over defects the app check had seen, over a
 * shipping pipeline whose review step had crashed, and onto a default branch that had moved
 * since anything was tested. So the reviewer decides `merge` and names the commit, and this
 * step, with no model, merges only when the record rules in `.shared/merge-gate.ts` hold, the
 * pull request's head is the reviewed commit, contains the current default branch, and is what
 * the app check tested (or that plus a clean merge of the default branch that touches none of
 * this change's files).
 * A refusal is posted as `Loop review: not merged`, so the next lap continues with the
 * reasons in hand. The forge is GitHub, through `gh`, like the rest of this loop.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { artifactsDir, emit, text, trimmed } from '../../.shared/io.ts';
import {
  CLOCK_SLACK_MS,
  isTrackingIssue,
  parseDispositions,
  parseJudgeChanges,
  readAppCheck,
  recordRefusals,
  shipFailuresInLog,
  untestedMerge,
} from '../../.shared/merge-gate.ts';
import { protectedFiles } from '../../.shared/protected-paths.ts';

const prUrl = trimmed(process.env.INPUTS_PR);
const named = trimmed(process.env.INPUTS_SHA);
const route = trimmed(process.env.INPUTS_ROUTE);
const target = trimmed(process.env.INPUTS_TARGET);
const delivers = trimmed(process.env.INPUTS_DELIVERS);
const evidenceProblems = text(process.env.INPUTS_EVIDENCE_PROBLEMS).split('\n').filter(line => line.trim() !== '');
const reviewStarted = Number(trimmed(process.env.INPUTS_REVIEW_STARTED)) || 0;
const prFiles = text(process.env.INPUTS_FILES).split('\n').map(f => f.trim()).filter(f => f !== '');
const logPath = join(trimmed(process.env.LOG_DIR), `${trimmed(process.env.WORKFLOW_ID)}.jsonl`);
const artifacts = artifactsDir();
const report = readAppCheck(text(process.env.INPUTS_REPORT));

function run(cmd: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

// A reviewer may name the commit by a short id (seen live); compare the full one it stands for.
const resolved = named === '' ? null : run(['git', 'rev-parse', '--verify', '--quiet', `${named}^{commit}`]);
const sha = resolved !== null && resolved.code === 0 ? resolved.out.trim() : named;

const tracking = new Map<string, boolean>();
const refusals = recordRefusals({
  report,
  evidenceProblems,
  dispositions: parseDispositions(text(process.env.INPUTS_DISPOSITIONS)),
  judgeChanges: parseJudgeChanges(text(process.env.INPUTS_JUDGE_CHANGES)),
  shipFailures: existsSync(logPath) ? shipFailuresInLog(readFileSync(logPath, 'utf8')) : [],
  // A non-empty file (not a folder, whose time moves with anything written inside it).
  freshFile: ref => {
    const path = ref === '' ? '' : isAbsolute(ref) ? ref : join(artifacts, ref);
    if (path === '' || !existsSync(path)) return false;
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 && stat.mtimeMs + CLOCK_SLACK_MS >= reviewStarted;
  },
  issueExists: ref => {
    const number = /^#?(\d+)$/.exec(ref)?.[1];
    if (number === undefined || prUrl.endsWith(`/pull/${number}`)) return false;
    if (!tracking.has(number)) {
      const view = run(['gh', 'issue', 'view', number, '--json', 'state,url']);
      tracking.set(number, view.code === 0 && isTrackingIssue(JSON.parse(view.out) as { state?: string; url?: string }));
    }
    return tracking.get(number) ?? false;
  },
});
if (route === 'complex' && !existsSync(logPath)) refusals.push('the run log is missing, so a failed shipping step cannot be ruled out');
const prNumber = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? url;
if (report.pr !== '' && prNumber(report.pr) !== prNumber(prUrl)) refusals.push(`the app check tested ${report.pr}, not ${prUrl}`);
// Files only the owner may change (governance, holdouts and the fence around them) never merge
// through the loop, whatever the review said: a reviewed change once rewrote a governance file.
const owned = protectedFiles(text(process.env.INPUTS_PROTECTED_PATHS), prFiles);
if (owned === 'invalid') refusals.push('protected_paths cannot be read, so a change to an owner-only file cannot be ruled out');
else if (owned.length > 0) refusals.push(`it changes ${owned.slice(0, 5).join(', ')}, which only the owner changes; the owner merges it by hand if it is intended`);

/** A commit's tree id, or '' when git does not know it. */
const treeOf = (commit: string): string => {
  const out = commit === '' ? null : run(['git', 'rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  return out !== null && out.code === 0 ? out.out.trim() : '';
};

let branch = '';
let alreadyMerged = false;
let landSha = sha;
let note = '';
const view = run(['gh', 'pr', 'view', prUrl, '--json', 'number,state,headRefOid,headRefName,baseRefName,isCrossRepository']);
if (view.code !== 0) {
  refusals.push(`could not read the pull request: ${view.err.trim().slice(0, 200)}`);
} else {
  const pr = JSON.parse(view.out) as {
    number: number;
    state: string;
    headRefOid: string;
    headRefName: string;
    baseRefName: string;
    isCrossRepository: boolean;
  };
  // A fork's branch is not ours to delete (a same-named branch here would go instead).
  branch = pr.isCrossRepository ? '' : pr.headRefName;
  if (pr.state === 'MERGED') alreadyMerged = true;
  else if (pr.state !== 'OPEN') refusals.push(`the pull request is ${pr.state.toLowerCase()}`);
  else if (pr.headRefOid !== sha) {
    refusals.push(`its head is ${pr.headRefOid.slice(0, 12)}, not the reviewed ${sha.slice(0, 12) || '(none named)'}`);
  } else {
    const base = `origin/${pr.baseRefName}`;
    const fetched = run(['git', 'fetch', '--quiet', 'origin', pr.baseRefName, `+refs/pull/${pr.number}/head:refs/remotes/origin/loop-land-${pr.number}`]);
    if (fetched.code !== 0) {
      refusals.push(`could not fetch ${pr.baseRefName}: ${fetched.err.trim().slice(0, 200)}`);
    } else {
      /** The tree of `commit` merged cleanly with the base, and the files the base brings in; '' on conflict. */
      const withBaseOf = (commit: string): { tree: string; fromBase: string[] } => {
        const out = run(['git', 'merge-tree', '--write-tree', commit, base]);
        const tree = out.code === 0 ? (out.out.split('\n')[0] ?? '').trim() : '';
        const fromBase = tree === '' ? [] : run(['git', 'diff', '--name-only', treeOf(commit), tree]).out.split('\n').filter(f => f !== '');
        return { tree, fromBase };
      };
      // The commit the check tested: its merge with the base, or the head when the merge changed nothing.
      const tested = treeOf(report.merged_with) !== '' ? report.merged_with : report.head;
      const t = withBaseOf(tested);
      const untested = untestedMerge({ shaTree: treeOf(sha), testedTree: treeOf(tested), withBaseTree: t.tree, fromBase: t.fromBase, prFiles });
      const baseMoved = run(['git', 'merge-base', '--is-ancestor', base, sha]).code !== 0;
      if (untested !== null) {
        refusals.push(`${untested}; the next lap checks the new head`);
      } else if (baseMoved) {
        // The base moved after the review. Throwing the lap away for that costs a whole new lap, so
        // the gate merges the base in itself when the merge is clean and touches none of this
        // change's files (what was tested stays exactly what lands, plus commits already on the base).
        const m = withBaseOf(sha);
        const shared = m.fromBase.filter(file => prFiles.includes(file));
        if (pr.isCrossRepository || m.tree === '' || shared.length > 0) {
          const why = m.tree === '' ? 'and conflicts with it' : shared.length > 0 ? `in ${shared.slice(0, 5).join(', ')}, which this change also changes` : '(a fork branch the gate cannot push to)';
          refusals.push(`${pr.baseRefName} has moved past what was tested ${why}; the next lap re-checks the merge`);
        } else {
          const made = run(['git', 'commit-tree', m.tree, '-p', sha, '-p', base, '-m', `Merge ${pr.baseRefName} into ${pr.headRefName} (merge gate: it touches no file of this change)`]);
          const commit = made.code === 0 ? made.out.trim() : '';
          const pushed = commit === '' ? null : run(['git', 'push', '--quiet', 'origin', `${commit}:refs/heads/${pr.headRefName}`]);
          if (pushed?.code !== 0) {
            refusals.push(`${pr.baseRefName} has moved past what was tested and the gate could not push the clean merge: ${(pushed?.err ?? made.err).trim().slice(0, 200)}`);
          } else {
            landSha = commit;
            note = ` (the gate merged ${pr.baseRefName} in first: ${m.fromBase.length} file(s) from it, none of this change's)`;
          }
        }
      }
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
  const merged = run(['gh', 'pr', 'merge', prUrl, '--squash', '--match-head-commit', landSha]);
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
    comment(`Loop review: merged (route: ${route}) at ${landSha} by the merge gate, after the review above${note}.`);
    emit({ outcome: 'merged', reason: `merged ${landSha}${note}` });
  }
}
