/**
 * Push the checkout's HEAD to a pull request's head branch, and prove it landed.
 *
 * This is publish-pr's push of the branch a pull request opens from. It names its
 * target explicitly — the head repository's remote (found by URL, ./remote.ts) and
 * the head branch — so git never picks an upstream. It never forces: a remote that moved refuses, and the refusal is
 * the evidence. A fork head no local remote names is pushed by its HTTPS URL, which
 * its author permits only when they allowed maintainer edits; the forge enforces that.
 * A nonzero push exit gets one retry after 20 seconds for transient remote failures.
 * After the push, the remote ref is read back and must equal HEAD.
 */

import type { QualifiedPr } from './forge.ts';
import { git, gitOrThrow } from './git.ts';
import { headDestination } from './remote.ts';

export interface PushTarget {
  readonly repo: QualifiedPr['repo'];
  readonly head_repo: QualifiedPr['repo'];
  readonly head: string;
}

/** Push HEAD to `head` on the head repository; returns the pushed commit. */
export function pushHead(target: PushTarget): string {
  const head = gitOrThrow('rev-parse', 'HEAD');
  const destination = headDestination(target, 'push');
  const ref = `refs/heads/${target.head}`;
  let pushed = git('push', destination, `HEAD:${ref}`);
  if (pushed.code !== 0) {
    Bun.sleepSync(20_000);
    pushed = git('push', destination, `HEAD:${ref}`);
  }
  if (pushed.code !== 0) throw new Error(`git push ${destination} HEAD:${ref} refused: ${pushed.stderr}`);
  const landed = gitOrThrow('ls-remote', destination, ref).split(/\s+/)[0] ?? '';
  if (landed !== head) {
    throw new Error(`pushed ${head} to ${destination} ${ref}, but the remote reads ${landed || 'nothing'}`);
  }
  return head;
}
