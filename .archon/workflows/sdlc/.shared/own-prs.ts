/**
 * Maintainers' own pull requests in the merge queue.
 *
 * A maintainer whose maintainer-list entry sets `merge_queue: "own-prs"` asks for each
 * of their open, non-draft pull requests to get a work item of its own, so a pull
 * request they opened by hand merges under the policy like one the build queue
 * delivered. Listing a maintainer's open pull requests needs a forge operation the
 * contract does not have yet (`OWN_PR_LISTING`), so enrollment refuses today. Items
 * enrolled earlier still merge through the queue.
 */

import type { QualifiedPr } from './forge.ts';
import type { WorkItem } from './workitem.ts';

/**
 * The forge operation own-PR enrollment needs and the contract does not have yet:
 * listing a repository's open pull requests by author.
 */
export const OWN_PR_LISTING = 'pr.list (open pull requests filtered by author)';

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
