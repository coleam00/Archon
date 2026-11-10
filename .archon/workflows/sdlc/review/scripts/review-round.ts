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
 * This node runs first, so it is the one owner of both commits: scope, route,
 * synthesis and publish read them from its output. It also emits one boolean per
 * lens, the facts a continuation's lens gates need: the code lens always reruns,
 * and so does every lens that a blocker still open in the previous round's
 * `findings.json` names in its `sources`, to verify the correction fixed it and
 * caused nothing new in its area. An open note does not rerun its lens: no
 * correction owes it a fix. A first round emits all six false. Whether any other
 * lens runs is the route agent's judgment.
 *
 * The prior report is a declared input an outside caller can fill with a path
 * from an earlier run, so its existence is checked here too: a continuation that
 * cannot read the report it continues from would review nothing and say it
 * reviewed everything. The `findings.json` beside it is read through its shared
 * reader, so a missing or malformed record refuses the round rather than
 * silently skipping a lens that owes a verification.
 *
 * The part assignment passes through unchanged: the node's `output_format` owns
 * its shape, so the engine refuses a malformed one before lenses or synthesis read it.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PRIOR_REPORT: the previous round's report path, or empty for round one.
 * - INPUTS_PART: the run's part assignment as JSON, or empty for the whole contract.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { readFindingsFile } from '../../.shared/review-item.ts';
import { FULL_REVIEW_RISKS, REVIEW_LENSES, type ReviewLens } from '../../.shared/review-policy.ts';
import { emit, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

/**
 * The bound part assignment. The refusal drops the parser's message, which quotes
 * a token of the operator's text.
 */
function partAssignment(value: string | undefined): NodeOutput<'archon-review', 'mode'>['part'] {
  try {
    return nullableJson(value) as NodeOutput<'archon-review', 'mode'>['part'];
  } catch {
    throw new Error('the part input is not JSON');
  }
}

/** Where publish-review records the commit a published report reviewed. */
const REVIEWED_HEAD = 'reviewed-head';

/** One boolean per lens, true for each lens named in `rerun`. */
function lensFlags(rerun: ReadonlySet<string>): Record<ReviewLens, boolean> {
  return Object.fromEntries(REVIEW_LENSES.map(lens => [lens, rerun.has(lens)])) as Record<ReviewLens, boolean>;
}

/** The code lens, and every lens a blocker still open in the previous round names. */
function owingLenses(findingsFile: string): Set<string> {
  const owing = new Set<string>(['code']);
  for (const finding of readFindingsFile(findingsFile)) {
    if (finding.severity === 'blocking' && finding.status === 'open') for (const source of finding.sources) owing.add(source);
  }
  return owing;
}

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
  const part = partAssignment(process.env.INPUTS_PART);
  const prior = trimmed(process.env.INPUTS_PRIOR_REPORT);
  const head = nodeStartCommit();
  if (prior === '') {
    emit<NodeOutput<'archon-review', 'mode'>>({ continuation: false, head, cursor: '', risks: FULL_REVIEW_RISKS, ...lensFlags(new Set()), part });
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
    const rerun = lensFlags(owingLenses(join(dirname(prior), 'findings.json')));
    emit<NodeOutput<'archon-review', 'mode'>>({ continuation: true, head, cursor, risks: FULL_REVIEW_RISKS, ...rerun, part });
  }
} catch (error) {
  refuse(`review-round: ${error instanceof Error ? error.message : String(error)}`);
}
