/**
 * Enroll maintainers' own open pull requests in the merge queue.
 *
 * A maintainer whose maintainer-list entry sets `merge_queue: "own-prs"` gets each of
 * their open, non-draft pull requests a work item of its own, so a pull request they
 * opened by hand merges under the policy like one the build queue delivered. A pull
 * request a work item already names, through a build round, the PR triage routed it to
 * continue, or an earlier enrollment, is left alone. So is one from a `build/` branch
 * in the repository itself: every build round opens its pull request from such a
 * branch, and it records the pull request only when the round ends. A hand-made pull
 * request on a `build/` branch therefore does not enroll.
 *
 * Listing a maintainer's open pull requests needs a forge operation the contract does
 * not have yet (`OWN_PR_LISTING`), so enrollment refuses today. Items enrolled earlier
 * still merge through the queue.
 */

import { BUILD_BRANCH_PREFIX } from './build.ts';
import type { QualifiedPr } from './forge.ts';
import type { WorkItem } from './workitem.ts';

/** The facts of an open pull request that say whether a build round opened it. */
interface OpenPr {
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
}

/**
 * The forge operation own-PR enrollment needs and the contract does not have yet:
 * listing a repository's open pull requests by author.
 */
export const OWN_PR_LISTING = 'pr.list (open pull requests filtered by author)';

/** A pull request from a round's branch: a `build/` branch in the repository itself. */
export function isQueueBuilt(pr: OpenPr): boolean {
  return !pr.isCrossRepository && pr.headRefName.startsWith(BUILD_BRANCH_PREFIX);
}

/** An enrolled own pull request that no build round has taken over since. */
export function isOwnPr(doc: WorkItem): boolean {
  return doc.facts.own_pr !== undefined && doc.facts.build === undefined;
}

/**
 * Create a work item for each own pull request no work item names. Enrollment lists a
 * maintainer's open pull requests, which no forge operation can do yet, so it refuses
 * when any maintainer opted in; the merge queue notes the refusal and goes on merging
 * the items that already exist.
 */
export function enrollOwnPrs(repo: QualifiedPr['repo'], authors: ReadonlySet<string>): void {
  if (authors.size === 0) return;
  throw new Error(
    `own-PR enrollment for ${repo.host}/${repo.path} needs the forge operation ${OWN_PR_LISTING}, which the forge plugin does not provide; no own pull request is enrolled`
  );
}
