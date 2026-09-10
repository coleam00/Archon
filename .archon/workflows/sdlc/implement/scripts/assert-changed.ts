/**
 * Deterministic guard: does this run have work to show?
 *
 * An AI node that declines its task still exits 0, so without this check the stages
 * after implement would spend money or go public on nothing. It reads Archon-owned
 * facts only -- git state and the run's own recorded artifacts -- never the project's
 * layout or toolchain.
 *
 * Four ways to pass, in order:
 * 1. The working tree changed since the run started (outside `.archon/`).
 * 2. Commits were made since the recorded start SHA.
 * 3. Verified existing work: no new change this run, but the loop declared green AND
 *    the branch already carries commits ahead of the base branch -- a rerun that
 *    verified a fix a prior run committed is progress, not a decline.
 * 4. An honest decline on red the change did not cause: nothing changed, the loop is
 *    not green, and it declared that red `inherited` or `environment` with evidence in
 *    its summary. A correction round can genuinely have nothing left to edit -- the
 *    remaining break is in the base, or in configuration the run has no permission to
 *    change -- and demanding a change anyway asks for an invented one, or throws away
 *    the rounds that already landed. What such a claim is worth is the green gates'
 *    question, not this one; the tolerance lives here only so a change that cannot
 *    exist stops being required.
 *
 * Red the loop introduced still fails with nothing to show, and so does red it left
 * unexplained or unevidenced -- the same bar the green gates hold, because a cause
 * with no failing check named behind it is not a reason. A green claim with neither
 * new work nor a branch lead fails too.
 *
 * Only UNCOMMITTED `.archon/` changes are excluded: Archon copies the operator's
 * workflow edits into every run worktree, so pre-existing uncommitted `.archon/` files
 * predate implement and are not its output. A commit made during the run counts as
 * work even when it only touches `.archon/` -- run-made commits are the run's output
 * (implement legitimately edits workflows).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, refuse, report, trimmedInput } from '../../.shared/io.ts';
import { PASSES_RED, parseDeclaredRedCause, passesRed } from '../../.shared/verdict.ts';

const EXCLUDE = ':(exclude).archon';

/** A git read whose failure is a broken assumption, not a state to report on. */
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** `undefined` when the ref does not resolve, which is an answer rather than a fault. */
function tryGit(...args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** Commits this branch carries beyond the base, or `undefined` if neither ref resolves. */
function commitsAheadOfBase(base: string): { readonly ref: string; readonly ahead: number } | undefined {
  for (const ref of [`origin/${base}`, base]) {
    const ahead = tryGit('rev-list', '--count', `${ref}..HEAD`);
    if (ahead !== undefined) return { ref, ahead: Number.parseInt(ahead, 10) };
  }
  return undefined;
}

type Decision = { readonly shown: string } | { readonly refusal: string };

function decide(): Decision {
  const start = readFileSync(join(artifactsDir(), '.start-sha'), 'utf-8').trim();
  // The loop's verdict, bound by the workflow (`with:`): green as canonical boolean
  // text ("true"/"false"), the declared cause of any red, and the summary that carries
  // the evidence for it.
  const green = trimmedInput('GREEN');
  const redCause = parseDeclaredRedCause(trimmedInput('RED_CAUSE'));
  const summary = trimmedInput('SUMMARY');

  const tracked = git('diff', '--name-only', 'HEAD', '--', EXCLUDE);
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', EXCLUDE);
  if (tracked !== '' || untracked !== '') {
    const stat = git('diff', '--stat', 'HEAD', '--', EXCLUDE);
    return { shown: stat === '' ? 'working-tree changes present' : (stat.split('\n').at(-1) ?? '') };
  }

  const head = git('rev-parse', 'HEAD');
  if (head !== start) {
    return { shown: `${git('rev-list', '--count', `${start}..HEAD`)} commit(s) made this run` };
  }

  const base = process.env.BASE_BRANCH ?? '';
  if (green === 'true' && base !== '') {
    const lead = commitsAheadOfBase(base);
    if (lead !== undefined && lead.ahead > 0) {
      return {
        shown:
          'no new changes this run; verified existing work -- ' +
          `${lead.ahead} commit(s) ahead of ${lead.ref}`,
      };
    }
  }

  // Nothing to show, and nothing to do about it. The evidence bar is the green gates'
  // own: emptiness is all that is checked, because whether the prose names a real
  // failing check is the declaring agent's judgment and the reviewer's.
  if (green !== 'true' && redCause !== undefined && passesRed(redCause) && summary !== '') {
    return {
      shown: `no new changes this run; the remaining red is declared ${redCause}, not introduced`,
    };
  }

  return {
    refusal:
      'implement produced neither a commit nor a working-tree change outside .archon/, ' +
      'and the branch carries no verified work ahead of the base ' +
      `(green=${green || 'unknown'}, red_cause=${redCause || 'unknown'}).\n` +
      'Nothing to show is only acceptable on red the change did not cause -- declared ' +
      `${PASSES_RED.join(' or ')}, with the failing check named in the summary. Red the ` +
      'change introduced, red nobody explained, and a cause with no evidence behind it ' +
      'fail here rather than reporting success.',
  };
}

const decision = decide();
if ('shown' in decision) {
  report(decision.shown);
} else {
  refuse(decision.refusal);
}
