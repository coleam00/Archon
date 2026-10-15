/**
 * Close an item triage found already resolved, linking it to what resolved it.
 *
 * Triage judges whether the item is a duplicate of an open issue or delivered by a
 * merged change, and whether the project's policy lets it close without a person;
 * this only performs that close. The closed item gets a comment linking the original
 * or the change, and a duplicate's original gets one linking back, so either side
 * leads to the other. Both comments are written before the close, each as one marked
 * comment, so a run that stops part way can be repeated without a second copy. An
 * item already closed for the closure's reason was closed by an earlier run or for the
 * same reason by someone else, so the repeat finishes without writing; one closed for
 * another reason is theirs and is refused.
 */

import { forgeSource, samePr, type QualifiedPr } from './forge.ts';
import { closeIssue, viewIssue } from './issue.ts';
import { upsertComment } from './pr.ts';

/** What made a `NO_ACTION` item closable, as triage declared it. */
export type Closure =
  | {
      readonly kind: 'duplicate';
      /** The open issue this one duplicates, and its URL. */
      readonly url: string;
      readonly original: QualifiedPr;
    }
  | {
      readonly kind: 'delivered';
      /** The merged change that already delivered the item's outcome. */
      readonly url: string;
    };

const CLOSED_MARKER = '<!-- archon-close -->';

function issueKey(item: QualifiedPr): string {
  return `${item.repo.host}/${item.repo.path}#${String(item.number)}`;
}

export function closeResolved(item: QualifiedPr, closure: Closure): void {
  const source = forgeSource();
  const reason = closure.kind === 'duplicate' ? 'duplicate' : 'completed';
  const closed = viewIssue(item);
  if (closed.state !== 'open') {
    closeIssue(item, reason);
    return;
  }
  if (closure.kind === 'duplicate') {
    if (samePr(item, closure.original)) {
      throw new Error(`${issueKey(item)} cannot be closed as a duplicate of itself`);
    }
    // The declared URL is what the closed item links to, so it must be the URL the
    // forge gives the declared original, which this read also proves is an issue.
    const original = viewIssue(closure.original);
    if (original.url.toLowerCase() !== closure.url.toLowerCase()) {
      throw new Error(
        `the duplicate's original ${issueKey(closure.original)} is ${original.url}, not ${closure.url}`
      );
    }
    if (original.state !== 'open') {
      throw new Error(`the duplicate's original ${original.url} is closed; a maintainer decides`);
    }
    upsertComment(
      { kind: 'issue', ref: item },
      CLOSED_MARKER,
      `${CLOSED_MARKER}\nClosing as a duplicate of ${original.url}; follow the work there.`,
      source
    );
    // One marked comment per duplicate: an original can collect several.
    const backMarker = `<!-- archon-duplicate ${issueKey(item)} -->`;
    upsertComment(
      { kind: 'issue', ref: closure.original },
      backMarker,
      `${backMarker}\n${closed.url} was closed as a duplicate of this issue.`,
      source
    );
    closeIssue(item, reason);
    return;
  }
  upsertComment(
    { kind: 'issue', ref: item },
    CLOSED_MARKER,
    `${CLOSED_MARKER}\nClosing as already delivered by ${closure.url}.`,
    source
  );
  closeIssue(item, reason);
}
