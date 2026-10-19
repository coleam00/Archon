import { sameRepo, type QualifiedPr, type ForgeSource } from './forge.ts';
import { git, gitOrThrow } from './git.ts';
import { viewPr } from './pr.ts';
import { headDestination } from './remote.ts';

export function checkoutPr(ref: QualifiedPr, source: ForgeSource, allowFork = false): string {
  const pr = viewPr(ref, source).pr;
  if (pr.state !== 'open' || pr.head_repo === null)
    throw new Error(`${pr.url} must be open with a head repository`);
  if (!sameRepo(pr.head_repo, ref.repo) && (!allowFork || pr.maintainer_can_modify !== true))
    throw new Error(`${pr.url} requires an allowed head repository and maintainer edits for a fork`);
  const destination = headDestination({ repo: pr.repo, head_repo: pr.head_repo });
  gitOrThrow('fetch', '--no-tags', destination, `refs/heads/${pr.head}`);
  const head = gitOrThrow('rev-parse', 'FETCH_HEAD');
  if (git('merge-base', '--is-ancestor', 'HEAD', head).code !== 0)
    throw new Error(`checkout cannot fast-forward exactly to PR head ${head}; local history is preserved`);
  const merged = git('merge', '--ff-only', '--no-edit', head);
  if (merged.code !== 0) throw new Error(`git merge ${head} failed: ${merged.stdout}\n${merged.stderr}`);
  if (gitOrThrow('rev-parse', 'HEAD') !== head) throw new Error(`checkout is not at PR head ${head}`);
  return head;
}
