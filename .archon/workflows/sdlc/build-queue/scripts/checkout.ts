/**
 * Move the run's checkout to the head of the pull request the round continues.
 *
 * The run's checkout is cut from the default branch. A round that continues a pull
 * request and adds nothing would otherwise publish that base onto the pull request's
 * head, which git refuses as a non-fast-forward. Starting from the pull request's head
 * makes publish a fast-forward, or a no-op when the round adds nothing.
 *
 * The checkout moves only when it is clean and its commit is already on a remote, so
 * nothing local is lost.
 *
 * A fresh round stays where it is, but only when that is on the repository's current
 * default branch: an adopted checkout left at a superseded pull request's head would
 * otherwise carry its commits into the replacement pull request. It refuses instead.
 *
 * Bound inputs: INPUTS_ITEM, the item from facts, whose repository names the base;
 * INPUTS_PULL_REQUEST, the item's pull request from facts, or null;
 * INPUTS_CANDIDATE, the number facts found continuable, else empty or `null`;
 * INPUTS_CONTINUES, the number route declared the round continues, else empty or `null`.
 * Route may decline the candidate, never name another pull request.
 *
 * It emits the pull request the round's `archon-ship` continues: the number, `none`
 * when the forge knows a pull request for the item that the round does not continue
 * (one route declined, or a closed, merged or fork one facts never offered), so ship's
 * triage cannot route the round back onto it, or null when the item has no pull
 * request, which leaves it to ship's triage. A declared null reaches ship as empty, so
 * `none` needs its own value.
 */

import type { PrRecord, QualifiedPr } from '../../.shared/forge.ts';
import { forgeSource } from '../../.shared/forge.ts';
import { git, gitOrThrow } from '../../.shared/git.ts';
import { emit, nullableJson, refuse } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';
import { fetchDefaultBranch, remoteFor } from '../../.shared/remote.ts';

function main(): void {
  const continues = nullableJson(process.env.INPUTS_CONTINUES) as number | null;
  const candidate = nullableJson(process.env.INPUTS_CANDIDATE) as number | null;
  const known = nullableJson(process.env.INPUTS_PULL_REQUEST) as PrRecord | null;
  if (continues === null) {
    const item = nullableJson(process.env.INPUTS_ITEM) as Pick<QualifiedPr, 'repo'>;
    const base = fetchDefaultBranch(item.repo);
    if (git('merge-base', '--is-ancestor', 'HEAD', base.sha).code !== 0)
      throw new Error(`a fresh round must start on ${base.branch}, but the checkout's HEAD is not on it`);
    emit({ head: null, pull_request: known === null ? null : 'none' });
    return;
  }
  if (continues !== candidate)
    throw new Error(`route continues pull request ${String(continues)}, but only ${String(candidate ?? 'none')} can be continued`);
  if (known === null || known.number !== continues)
    throw new Error(`route continues pull request ${String(continues)} but reports ${String(known?.number ?? 'none')}`);
  const pr = viewPr({ repo: known.repo, number: continues }, forgeSource()).pr;
  if (pr.state !== 'open' || pr.head_revision === null)
    throw new Error(`${pr.url} is ${pr.state}; the round cannot continue it`);

  if (gitOrThrow('status', '--porcelain') !== '') throw new Error('the checkout has uncommitted changes');
  if (gitOrThrow('branch', '-r', '--contains', 'HEAD') === '')
    throw new Error('the checkout has commits no remote holds; it is left as it is');
  gitOrThrow('fetch', '--no-tags', remoteFor(pr.repo), `refs/heads/${pr.head}`);
  const head = gitOrThrow('rev-parse', 'FETCH_HEAD');
  if (head !== pr.head_revision)
    throw new Error(`${pr.url} reports head ${pr.head_revision}, but its branch is at ${head}`);
  const branch = gitOrThrow('branch', '--show-current');
  gitOrThrow('checkout', '-q', ...(branch === '' ? ['--detach'] : ['-B', branch]), head);
  emit({ head, pull_request: continues });
}

try {
  main();
} catch (error) {
  refuse(`build-queue checkout: ${error instanceof Error ? error.message : String(error)}`);
}
