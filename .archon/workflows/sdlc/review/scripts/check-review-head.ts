/**
 * Fix the review target before any lens runs, from facts the run can establish.
 *
 * The target is resolved from the requested scope (a recorded PR, number, URL,
 * branch, or empty for the current branch's open PR) through the forge, not from
 * anything the scope agent says about it. A PR review proceeds only when the PR's
 * head is the commit this round fixed; otherwise the node refuses with retry
 * commands for the PR's head. The output is the PR and its live diff base, which
 * publication checks again before its public write.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_SCOPE: the review's requested scope.
 * - INPUTS_SELECTOR: the scope agent's selector, read only when INPUTS_SCOPE is
 *   empty: its reading of a target the trigger message names.
 * - INPUTS_HEAD: the commit this round reviews, as review-round fixed it.
 */

import { nodeStartCommit } from '../../.shared/checkout.ts';
import { forgeSource, sameRepo, type PrRecord } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import { findRemote } from '../../.shared/remote.ts';
import {
  liveReviewBase,
  resolveReviewPr,
  retainedReviewRef,
  reviewHead,
} from '../../.shared/review-target.ts';

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function retry(pr: PrRecord, head: string): string {
  const scope = `--input ${quote(`scope=${pr.url}`)}`;
  const retained = 'Retain any other non-default review inputs when retrying.';
  const branch =
    pr.head_revision !== null &&
    pr.state === 'open' &&
    pr.head_repo !== null &&
    sameRepo(pr.repo, pr.head_repo)
      ? `Retry on the PR branch:\narchon workflow run archon-review --branch ${quote(pr.head)} ${scope}\n`
      : '';
  let remote = `https://${pr.repo.host}/${pr.repo.path}.git`;
  let diagnostic = '';
  try {
    remote = findRemote(pr.repo) ?? remote;
  } catch (error) {
    diagnostic = `Remote discovery failed; the fetch uses the base repository URL: ${error instanceof Error ? error.message : String(error)}\n`;
  }
  const ref = retainedReviewRef(pr);
  return (
    branch +
    diagnostic +
    `Or fetch the PR head and start an isolated review pinned to this commit:\n` +
    `git fetch -- ${quote(remote)} ${quote(ref)}\n` +
    `archon workflow run archon-review --from ${quote(head)} ${scope}\n${retained}`
  );
}

try {
  const head = text(process.env.INPUTS_HEAD).trim();
  const checkout = nodeStartCommit();
  if (checkout !== head) {
    throw new Error(`this round fixed ${head}, but the checkout is now at ${checkout}`);
  }
  const pr = resolveReviewPr(
    text(process.env.INPUTS_SCOPE).trim() || text(process.env.INPUTS_SELECTOR).trim(),
    forgeSource()
  );
  if (!pr) {
    note('check-review-head: no open PR; reviewing the working diff.');
    emit({ pr: null, base: null });
  } else {
    const remoteHead = reviewHead(pr);
    if (remoteHead !== head) {
      throw new Error(
        `the checkout is at ${head}, but ${pr.repo.host}/${pr.repo.path}#${String(pr.number)} ` +
          `is at ${remoteHead}, so this run cannot review the PR's head. ` +
          `No review lenses ran.\n${retry(pr, remoteHead)}`
      );
    }
    note('check-review-head: the PR head is the commit under review.');
    emit({ pr: { repo: pr.repo, number: pr.number }, base: liveReviewBase(pr) });
  }
} catch (error) {
  refuse(`check-review-head: ${error instanceof Error ? error.message : String(error)}`);
}
