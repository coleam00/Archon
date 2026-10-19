import { sameRepo, type QualifiedPr, type ForgeSource } from './forge.ts';
import { git, gitOrThrow } from './git.ts';
import { viewPr } from './pr.ts';
import { remoteFor } from './remote.ts';

export function checkoutPr(ref: QualifiedPr, source: ForgeSource, allowFork = false): string {
  const pr = viewPr(ref, source).pr;
  if (pr.state !== 'open' || pr.head_repo === null)
    throw new Error(`${pr.url} must be open with a head repository`);
  if (!sameRepo(pr.head_repo, ref.repo) && (!allowFork || pr.maintainer_can_modify !== true))
    throw new Error(`${pr.url} requires an allowed head repository and maintainer edits for a fork`);
  gitOrThrow('fetch', '--no-tags', remoteFor(pr.head_repo), `refs/heads/${pr.head}`);
  const head = gitOrThrow('rev-parse', 'FETCH_HEAD');
  const merged = git('merge', '--ff', '--no-edit', head);
  if (merged.code !== 0) throw new Error(`git merge ${head} failed: ${merged.stdout}\n${merged.stderr}`);
  gitOrThrow('merge-base', '--is-ancestor', head, 'HEAD');
  return head;
}
