/**
 * Fix what this review round reviews: the mode, the commit, and the cursor.
 *
 * The reviewed commit is the checkout's HEAD when the round starts, as the engine
 * observed it. Nothing an agent reads chooses it: a recorded pull request's
 * `head_revision` is captured when the PR opens and goes stale with every later
 * push, so a round that trusted it would review an older commit than the one the
 * PR carries. publish-review checks the same commit against the checkout and the
 * PR's remote head before the verdict goes public, then records it beside the
 * report as the next round's cursor.
 *
 * A continuation round's cursor is that recorded commit. The head must descend
 * from it: a head that is the cursor's ancestor, or off its history, would make
 * the delta run backwards or cover commits the previous round never read, so the
 * round refuses instead.
 *
 * The prior report is a declared input an outside caller can fill with a path
 * from an earlier run, so its existence is checked here too: a continuation that
 * cannot read the report it continues from would review nothing and say it
 * reviewed everything.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PRIOR_REPORT: the previous round's report path, or empty for round one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { FULL_REVIEW_RISKS } from '../../.shared/review-policy.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';

/** Where publish-review records the commit a published report reviewed. */
const REVIEWED_HEAD = 'reviewed-head';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function descends(head: string, cursor: string): boolean {
  const result = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', cursor, head]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `could not compare ${head} with the previous round's reviewed commit ${cursor}: ${result.stderr.toString().trim()}`
  );
}

try {
  const prior = trimmed(process.env.INPUTS_PRIOR_REPORT);
  const head = nodeStartCommit();
  if (prior === '') {
    emit({ continuation: false, head, cursor: '', risks: FULL_REVIEW_RISKS });
  } else {
    if (!isFile(prior)) throw new Error(`the previous review report does not exist: ${prior}`);
    const recorded = join(dirname(prior), REVIEWED_HEAD);
    if (!existsSync(recorded)) {
      throw new Error(
        `the previous review report records no reviewed commit (${recorded} is missing)`
      );
    }
    const cursor = readFileSync(recorded, 'utf8').trim();
    if (!descends(head, cursor)) {
      throw new Error(
        `the checkout is at ${head}, which does not descend from ${cursor}, the commit the previous round reviewed; reviewing it would diff backwards or skip commits`
      );
    }
    emit({ continuation: true, head, cursor, risks: FULL_REVIEW_RISKS });
  }
} catch (error) {
  refuse(`review-round: ${error instanceof Error ? error.message : String(error)}`);
}
