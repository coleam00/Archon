/**
 * The review's head rule: a round's verdict is about one commit, and it stands on a
 * pull request only while that pull request's remote head is that commit.
 *
 * publish-review applies it before the verdict goes public: the head can move during
 * a long review, and a standalone review can start from another checkout.
 */

import type { QualifiedPr } from './identity.ts';
import { viewPr } from './pr.ts';

/** Refuse unless the pull request's remote head is the commit this round reviews. */
export function requirePrHead(pr: QualifiedPr, head: string): void {
  const remote = viewPr(pr).pr.head_revision;
  if (remote !== head) {
    throw new Error(
      `this round reviewed ${head}, but ${pr.repo.host}/${pr.repo.path}#${String(pr.number)} is at ${remote ?? 'an unknown head'}: push the commits under review, or review from a checkout of the pull request's head`
    );
  }
}
