import type { PrRecord } from '../../.shared/forge.ts';
import { forgeSource, sameRepo } from '../../.shared/forge.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { emit, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';
import { remoteFor } from '../../.shared/remote.ts';

function main(): void {
  const branch = trimmed(process.env.INPUTS_BRANCH);
  if (branch === '' || gitOrThrow('branch', '--show-current') !== branch)
    throw new Error(`the checkout is not on selected branch ${branch}; it is left as it is`);
  const continues = nullableJson(process.env.INPUTS_CONTINUES) as number | null;
  if (continues === null) {
    emit({ head: null });
    return;
  }
  const known = nullableJson(process.env.INPUTS_PULL_REQUEST) as PrRecord | null;
  if (known === null || known.number !== continues)
    throw new Error(`facts continues pull request ${String(continues)} but reports ${String(known?.number ?? 'none')}`);
  const pr = viewPr({ repo: known.repo, number: continues }, forgeSource()).pr;
  if (pr.head !== branch || pr.head_repo === null || !sameRepo(pr.head_repo, known.repo))
    throw new Error(`${pr.url} no longer names the selected branch in this repository`);
  if (pr.state !== 'open' || pr.head_revision === null)
    throw new Error(`${pr.url} is ${pr.state}; the round cannot continue it`);

  if (gitOrThrow('status', '--porcelain') !== '') throw new Error('the checkout has uncommitted changes');
  if (gitOrThrow('branch', '-r', '--contains', 'HEAD') === '')
    throw new Error('the checkout has commits no remote holds; it is left as it is');
  gitOrThrow('fetch', '--no-tags', remoteFor(pr.repo), `refs/heads/${pr.head}`);
  const head = gitOrThrow('rev-parse', 'FETCH_HEAD');
  if (head !== pr.head_revision)
    throw new Error(`${pr.url} reports head ${pr.head_revision}, but its branch is at ${head}`);
  gitOrThrow('merge', '--ff-only', '--no-edit', head);
  emit({ head });
}

try {
  main();
} catch (error) {
  refuse(`build-queue checkout: ${error instanceof Error ? error.message : String(error)}`);
}
