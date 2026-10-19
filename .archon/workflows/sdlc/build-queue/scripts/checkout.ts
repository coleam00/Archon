import { forgeSource, parseQualifiedPr, sameRepo } from '../../.shared/forge.ts';
import { git, gitOrThrow } from '../../.shared/git.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';
import { remoteFor } from '../../.shared/remote.ts';

function main(): void {
  const continues = trimmed(process.env.INPUTS_CONTINUES);
  if (continues === '' || continues === 'null') {
    emit({ head: null });
    return;
  }
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const number = Number(continues);
  if (!Number.isInteger(number) || number <= 0) throw new Error('continues must be a positive PR number');
  const pr = viewPr({ repo: item.repo, number }, forgeSource()).pr;
  if (pr.state !== 'open' || pr.head_repo === null || !sameRepo(pr.head_repo, item.repo))
    throw new Error(`${pr.url} must be open with a head in ${item.repo.host}/${item.repo.path}`);
  gitOrThrow('fetch', '--no-tags', remoteFor(pr.head_repo), `refs/heads/${pr.head}`);
  const head = gitOrThrow('rev-parse', 'FETCH_HEAD');
  const merged = git('merge', '--ff', '--no-edit', head);
  if (merged.code !== 0) throw new Error(`git merge ${head} failed: ${merged.stdout}\n${merged.stderr}`);
  gitOrThrow('merge-base', '--is-ancestor', head, 'HEAD');
  emit({ head });
}

try {
  main();
} catch (error) {
  refuse(`build-queue checkout: ${error instanceof Error ? error.message : String(error)}`);
}
