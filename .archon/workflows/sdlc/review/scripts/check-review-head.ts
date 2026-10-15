/** Refuse before lenses unless the scoped PR identity, head and effective diff still match. */

import { nodeStartCommit } from '../../.shared/checkout.ts';
import { forgeSource, samePr, sameRepo, type PrRecord } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import { findRemote } from '../../.shared/remote.ts';
import {
  parseReviewTarget,
  resolveReviewPr,
  retainedReviewRef,
  reviewHead,
  reviewMergeBase,
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
  const target = parseReviewTarget(text(process.env.INPUTS_TARGET));
  if (target.head !== head) throw new Error("scope did not review this round's head");
  const pr = resolveReviewPr(
    text(process.env.INPUTS_SCOPE).trim() || text(process.env.INPUTS_SELECTOR).trim(),
    forgeSource()
  );
  if (!pr) {
    if (target.pr !== null) throw new Error('scoped PR does not match the resolved working diff');
    note('check-review-head: no open PR; reviewing the working diff.');
    emit(target);
  } else {
    const remoteHead = reviewHead(pr);
    if (remoteHead !== head) {
      throw new Error(
        `the checkout is at ${head}, but ${pr.repo.host}/${pr.repo.path}#${String(pr.number)} ` +
          `is at ${remoteHead}, so this run cannot review the PR's head. ` +
          `No review lenses ran.\n${retry(pr, remoteHead)}`
      );
    }
    if (target.pr === null || !samePr(target.pr, pr)) {
      throw new Error('scoped PR identity does not match the resolved review target');
    }
    if (reviewMergeBase(pr, head) !== target.merge_base) {
      throw new Error(
        'the effective PR diff changed since scope; review the new diff. No review lenses ran.'
      );
    }
    note('check-review-head: the scoped PR head and effective diff match.');
    emit(target);
  }
} catch (error) {
  refuse(`check-review-head: ${error instanceof Error ? error.message : String(error)}`);
}
