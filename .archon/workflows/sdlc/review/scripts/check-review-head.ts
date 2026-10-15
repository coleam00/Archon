import { nodeStartCommit } from '../../.shared/checkout.ts';
import { forgeSource, record, samePr, sameRepo, type PrRecord } from '../../.shared/forge.ts';
import { report, refuse, text } from '../../.shared/io.ts';
import { findRemote } from '../../.shared/remote.ts';
import {
  checkReviewBase,
  declaredPr,
  recordedPr,
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
  const scope = text(process.env.INPUTS_SCOPE);
  const recorded = recordedPr(scope);
  const target = record(JSON.parse(text(process.env.INPUTS_TARGET)));
  if (!target || !('pr' in target) || !('base' in target)) throw new Error('missing review target');
  const declared = declaredPr(JSON.stringify(target.pr));
  if (recorded && (!declared || !samePr(declared, recorded))) {
    throw new Error('the scope declaration does not match the recorded pull request');
  }
  const pr = resolveReviewPr(
    scope.trim() || text(process.env.INPUTS_SELECTOR).trim(),
    forgeSource()
  );
  if (pr ? !declared || !samePr(declared, pr) : declared !== undefined) {
    throw new Error(
      'the scope declaration does not match the resolved pull request. No review lenses ran.' +
        (pr ? `\n${retry(pr, reviewHead(pr))}` : '')
    );
  }
  if (pr) {
    const remoteHead = reviewHead(pr);
    if (remoteHead !== head) {
      throw new Error(
        `${pr.repo.host}/${pr.repo.path}#${String(pr.number)} is at ` +
          `${remoteHead}, but this round fixed ${head}. ` +
          `No review lenses ran.\n${retry(pr, remoteHead)}`
      );
    }
    checkReviewBase(pr, JSON.stringify(target.base));
  }
  report(
    pr
      ? 'check-review-head: the resolved target matches the commit under review.'
      : 'check-review-head: no open PR; reviewing the working diff.'
  );
} catch (error) {
  refuse(`check-review-head: ${error instanceof Error ? error.message : String(error)}`);
}
