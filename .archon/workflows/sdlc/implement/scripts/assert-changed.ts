/**
 * Deterministic guard: did this implement invocation produce work?
 *
 * An AI node that declines its task still exits 0, so without this check the stages
 * after implement would spend money or go public on nothing. It reads Archon-owned
 * facts only -- the engine's checkout delta and git refs -- never the
 * project's layout or toolchain.
 *
 * Three ways to pass, in order:
 * 1. New content: some path's content, mode, or type differs from where THIS implement
 *    invocation started. The start is the engine's own observation of the implement
 *    node's invocation, bound as `baseline`. Changes that
 *    were already in the checkout when it started are part of that start, so a dirty
 *    checkout the loop never touched does not pass. HEAD moving, staging, or an empty
 *    commit changes no content and does not pass either.
 * 2. Verified existing work: no new content, but the loop declared green AND the branch
 *    already carries commits ahead of the base branch -- a rerun that verified a fix a
 *    prior run committed is progress, not a decline.
 * 3. An honest decline on red the change did not cause: no new content, the loop is not
 *    green, and it declared that red `inherited` or `environment` with evidence in its
 *    summary. A correction round can genuinely have nothing left to edit -- the
 *    remaining break is in the base, or in configuration the run has no permission to
 *    change -- and demanding a change anyway asks for an invented one, or throws away
 *    the rounds that already landed. What such a claim is worth is the green gates'
 *    question, not this one; the tolerance lives here only so a change that cannot
 *    exist stops being required.
 *
 * Red the loop introduced still fails with nothing to show, and so does red it left
 * unexplained or unevidenced -- the same bar the green gates hold, because a cause
 * with no failing check named behind it is not a reason. A green claim with neither
 * new content nor a branch lead fails too.
 *
 * A loop that ended with its checks unfinished (`incomplete`) fails before any of
 * that is asked, whatever it changed: its work was never verified, and the green
 * gates refuse the same cause with the same message.
 *
 * Comparison is the engine's: `changes` is its delta from the implement invocation's
 * start to this node's own start (`$implement.execution.checkoutChanges`), counting only
 * paths whose content, mode, or type differ. A delta the engine could not establish
 * arrives as `unknown` with its reason, and cannot prove new work.
 */

import { refuse, report, trimmed } from '../../.shared/io.ts';
import { PASSES_RED, passesRed, unfinishedValidation } from '../../.shared/verdict.ts';

/** `undefined` when the ref does not resolve, which is an answer rather than a fault. */
function tryGit(...args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/**
 * Commits this branch carries beyond the base, or `undefined` when no base ref resolves.
 *
 * Every copy of the base counts — the local branch and the same branch on each
 * remote, whatever the remotes are named — and the fewest commits ahead wins, so a
 * stale fork's base never makes base commits look like this branch's work.
 */
function commitsAheadOfBase(base: string): { readonly ref: string; readonly ahead: number } | undefined {
  const remotes = (tryGit('for-each-ref', '--format=%(refname:short)', `refs/remotes/*/${base}`) ?? '')
    .split('\n')
    .filter(ref => ref !== '');
  let best: { readonly ref: string; readonly ahead: number } | undefined;
  for (const ref of [...remotes, base]) {
    const ahead = tryGit('rev-list', '--count', `${ref}..HEAD`);
    if (ahead === undefined) continue;
    const count = Number.parseInt(ahead, 10);
    if (best === undefined || count < best.ahead) best = { ref, ahead: count };
  }
  return best;
}

/** Why the engine could not establish the delta, phrased to complete "because ...". */
const UNKNOWN_BECAUSE: Readonly<Record<string, string>> = {
  not_git: 'was not a Git checkout',
  unavailable: 'could not be observed',
  incomplete: 'could not identify every changed path',
  manifest_unreadable: 'has a manifest that could not be read',
};

/**
 * The engine's delta, read for the one fact this guard needs: how many paths changed,
 * or why that is unknown. Anything else is unknown too, never zero.
 */
function readChanges(text: string): { readonly changed: number } | { readonly unknown: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { unknown: 'the engine supplied no checkout delta' };
  }
  const changes = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (changes.status === 'known' && typeof changes.changed === 'number') {
    return { changed: changes.changed };
  }
  if (changes.status === 'unknown') {
    const side = changes.side === 'end' ? 'the current checkout' : 'the implement start';
    const because = UNKNOWN_BECAUSE[String(changes.reason)];
    return {
      unknown:
        because !== undefined
          ? `${side} ${because}`
          : `the engine could not compare the checkouts (${String(changes.reason)})`,
    };
  }
  return { unknown: 'the checkout delta is not one this guard can read' };
}

type Decision = { readonly shown: string } | { readonly refusal: string };

function decide(): Decision {
  // The loop's verdict, bound by the workflow (`with:`): green as canonical boolean
  // text ("true"/"false"), the declared cause of any red, and the summary that carries
  // the evidence for it. `changes` is the engine's delta since the implement invocation
  // started.
  const green = trimmed(process.env.INPUTS_GREEN);
  // Certified at the loop's own node: `red_cause` is an enum on its output_format,
  // so the value here is a member or the empty string, never something to re-check.
  const declaredCause = trimmed(process.env.INPUTS_RED_CAUSE);
  const summary = trimmed(process.env.INPUTS_SUMMARY);
  if (declaredCause === 'incomplete') {
    return { refusal: unfinishedValidation('The implementation', summary) };
  }

  let unknownReason: string | undefined;
  const changes = readChanges(trimmed(process.env.INPUTS_CHANGES));
  if ('unknown' in changes) unknownReason = changes.unknown;
  else if (changes.changed > 0) {
    return {
      shown: `${String(changes.changed)} path(s) changed since this implement invocation started`,
    };
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
  if (green !== 'true' && passesRed(declaredCause) && summary !== '') {
    return {
      shown: `no new changes this run; the remaining red is declared ${declaredCause}, not introduced`,
    };
  }

  // A loop that stopped on a blocker it declared is not unexplained red: name it.
  if (green !== 'true' && declaredCause === '' && summary !== '' && unknownReason === undefined) {
    return {
      refusal:
        `implement declared a blocker: ${summary}\n` +
        'It changed no content since this invocation started, and the branch carries no ' +
        'verified work ahead of the base.',
    };
  }

  return {
    refusal:
      (unknownReason !== undefined
        ? `implement's new work cannot be established: ${unknownReason}. `
        : 'implement changed no content since this invocation started ' +
          '(pre-existing uncommitted changes are part of that start), ') +
      'and the branch carries no verified work ahead of the base ' +
      `(green=${green || 'unknown'}, red_cause=${declaredCause || 'unknown'}).\n` +
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
