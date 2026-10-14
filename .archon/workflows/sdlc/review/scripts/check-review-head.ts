import { nodeStartCommit } from '../../.shared/checkout.ts';
import { forgeSource, samePr, sameRepo, type PrRecord } from '../../.shared/forge.ts';
import { report, refuse, text } from '../../.shared/io.ts';
import { findRemote } from '../../.shared/remote.ts';
import { declaredPr, recordedPr, resolveReviewPr } from '../../.shared/review-target.ts';

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function retry(pr: PrRecord): string {
  const scope = `--input ${quote(`scope=${pr.url}`)}`;
  const retained = 'Retain any other non-default review inputs when retrying.';
  if (pr.head_revision === null || pr.head_repo === null) {
    return (
      `Restore resolution of the PR's head revision and head repository first, then retry:\n` +
      `archon workflow run archon-review --branch ${quote(pr.head)} ${scope}\n${retained}`
    );
  }
  const branch = sameRepo(pr.repo, pr.head_repo)
    ? `Retry on the PR branch:\narchon workflow run archon-review --branch ${quote(pr.head)} ${scope}\n`
    : '';
  let remote = `https://${pr.head_repo.host}/${pr.head_repo.path}.git`;
  let diagnostic = '';
  try {
    remote = findRemote(pr.head_repo) ?? remote;
  } catch (error) {
    diagnostic = `Remote discovery failed; the fetch uses the head repository URL: ${error instanceof Error ? error.message : String(error)}\n`;
  }
  return (
    branch +
    diagnostic +
    `Or fetch the PR head and start an isolated review pinned to this commit:\n` +
    `git fetch -- ${quote(remote)} ${quote(`refs/heads/${pr.head}`)}\n` +
    `archon workflow run archon-review --from ${quote(pr.head_revision)} ${scope}\n${retained}`
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
  const declared = declaredPr(text(process.env.INPUTS_PR));
  if (recorded && (!declared || !samePr(declared, recorded))) {
    throw new Error('the scope declaration does not match the recorded pull request');
  }
  const pr = resolveReviewPr(text(process.env.INPUTS_SELECTOR).trim() || scope, forgeSource());
  if (pr ? !declared || !samePr(declared, pr) : declared !== undefined) {
    throw new Error(
      'the scope declaration does not match the resolved pull request. No review lenses ran.' +
        (pr ? `\n${retry(pr)}` : '')
    );
  }
  if (pr && pr.head_revision !== head) {
    throw new Error(
      `${pr.repo.host}/${pr.repo.path}#${String(pr.number)} is at ` +
        `${pr.head_revision ?? 'an unknown head'}, but this round fixed ${head}. ` +
        `No review lenses ran.\n${retry(pr)}`
    );
  }
  report(
    pr
      ? 'check-review-head: the resolved target matches the commit under review.'
      : 'check-review-head: no open PR; reviewing the working diff.'
  );
} catch (error) {
  refuse(`check-review-head: ${error instanceof Error ? error.message : String(error)}`);
}
