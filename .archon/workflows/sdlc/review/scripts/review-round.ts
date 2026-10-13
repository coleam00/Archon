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
 * The mode also decides which lenses run. A first round asks the route agent
 * (`route: true`). A later round reruns the selection recorded beside the prior
 * report on the correction delta, so the same reviewers judge whether their
 * findings were resolved or validly declined; a `light` round, after a CI fix,
 * runs the general code reviewer alone. A continuation whose report recorded no
 * selection (one from an older run) asks the route agent again.
 *
 * The prior report is a declared input an outside caller can fill with a path
 * from an earlier run, so its existence is checked here too: a continuation that
 * cannot read the report it continues from would review nothing and say it
 * reviewed everything.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PRIOR_REPORT: the previous round's report path, or empty for round one.
 * - INPUTS_DEPTH: `light` for a round after a CI fix; anything else reruns the
 *   recorded selection.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { FULL_REVIEW_RISKS } from '../../.shared/review-policy.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';

/** Where publish-review records the commit a published report reviewed. */
const REVIEWED_HEAD = 'reviewed-head';
/** Where publish-review records the lenses the route agent selected. */
const LENSES = 'lenses.json';

interface Selection {
  readonly route: boolean;
  readonly seams: boolean;
  readonly code: boolean;
  readonly tests: boolean;
  readonly errors: boolean;
  readonly docs: boolean;
}

const ASK_ROUTE: Selection = { route: true, seams: false, code: false, tests: false, errors: false, docs: false };

/** The lenses a continuation reruns. */
function rerun(prior: string): Selection {
  if (trimmed(process.env.INPUTS_DEPTH) === 'light') {
    return { route: false, seams: false, code: true, tests: false, errors: false, docs: false };
  }
  const recorded = join(dirname(prior), LENSES);
  if (!existsSync(recorded)) return ASK_ROUTE;
  const lenses = JSON.parse(readFileSync(recorded, 'utf8')) as Record<string, unknown>;
  const on = (name: string): boolean => lenses[name] === true;
  return { route: false, seams: on('seams'), code: on('code'), tests: on('tests'), errors: on('errors'), docs: on('docs') };
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
  const prior = trimmed(process.env.INPUTS_PRIOR_REPORT);
  const head = nodeStartCommit();
  // The engine's identity for this node, which synthesis uses to count only this
  // round's lens artifacts.
  const execution: unknown = JSON.parse(process.env.ARCHON_NODE_EXECUTION ?? '');
  if (prior === '') {
    emit({ continuation: false, head, cursor: '', risks: FULL_REVIEW_RISKS, execution, ...ASK_ROUTE });
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
    emit({ continuation: true, head, cursor, risks: FULL_REVIEW_RISKS, execution, ...rerun(prior) });
  }
} catch (error) {
  refuse(`review-round: ${error instanceof Error ? error.message : String(error)}`);
}
