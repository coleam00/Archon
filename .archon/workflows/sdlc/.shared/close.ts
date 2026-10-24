/**
 * Close an item triage found already resolved, linking it to what resolved it.
 *
 * Triage judges whether the item is a duplicate of an open issue or delivered by a
 * merged change, and whether the project's policy lets it close without a person;
 * this checks the declared closure against the forge and performs the close. The
 * checks only read, so the caller learns of a refusal before it writes anything and
 * can leave the item to a maintainer instead of storing it as closing.
 *
 * The closed item gets a comment linking the original or the change, and a
 * duplicate's original gets one linking back, so either side leads to the other.
 * Both comments are written before the close, each as one marked comment, so a run
 * that stops part way can be repeated without a second copy. An item already closed
 * for the closure's reason was closed by an earlier run or for the same reason by
 * someone else, so the repeat finishes without writing; one closed for another reason
 * is theirs and the close throws.
 */

import { forgeSource, samePr, type QualifiedPr } from './forge.ts';
import { closeIssue, type IssueView, NotAnIssueError, viewIssue } from './issue.ts';
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

/** The checked close: why it may not happen, or the writes that perform it. */
export type ClosePlan =
  | { readonly refused: string }
  | { readonly refused: null; readonly close: () => void };

/** Read what the close depends on and decide whether it may happen; writes nothing. */
export function planClose(item: QualifiedPr, closure: Closure): ClosePlan {
  const reason = closure.kind === 'duplicate' ? 'duplicate' : 'completed';
  const closed = viewIssue(item);
  if (closed.state !== 'open') {
    return { refused: null, close: (): void => { closeIssue(item, reason); } };
  }
  if (closure.kind === 'delivered') {
    return { refused: null, close: (): void => { closeWithComments(item, closed.url, closure); } };
  }
  if (samePr(item, closure.original)) {
    return { refused: `${issueKey(item)} cannot be closed as a duplicate of itself` };
  }
  let original: IssueView;
  try {
    original = viewIssue(closure.original);
  } catch (error) {
    if (error instanceof NotAnIssueError) {
      return { refused: `the duplicate's original ${error.message}` };
    }
    throw error;
  }
  // The declared URL is what the closed item links to, so it must be the URL the
  // forge gives the declared original.
  if (original.url.toLowerCase() !== closure.url.toLowerCase()) {
    return {
      refused: `the duplicate's original ${issueKey(closure.original)} is ${original.url}, not ${closure.url}`,
    };
  }
  if (original.state !== 'open') {
    return { refused: `the duplicate's original ${original.url} is closed` };
  }
  return { refused: null, close: (): void => { closeWithComments(item, closed.url, { ...closure, url: original.url }); } };
}

/** The exact text and destinations of a declared closure, shared with the intake bench. */
export function closeComments(item: QualifiedPr, itemUrl: string, closure: Closure): readonly {
  readonly item: QualifiedPr;
  readonly marker: string;
  readonly body: string;
}[] {
  if (closure.kind === 'delivered') {
    return [{ item, marker: CLOSED_MARKER, body: `${CLOSED_MARKER}\nClosing as already delivered by ${closure.url}.` }];
  }
  const backMarker = `<!-- archon-duplicate ${issueKey(item)} -->`;
  return [
    { item, marker: CLOSED_MARKER, body: `${CLOSED_MARKER}\nClosing as a duplicate of ${closure.url}; follow the work there.` },
    { item: closure.original, marker: backMarker, body: `${backMarker}\n${itemUrl} was closed as a duplicate of this issue.` },
  ];
}

function closeWithComments(item: QualifiedPr, itemUrl: string, closure: Closure): void {
  const source = forgeSource();
  for (const comment of closeComments(item, itemUrl, closure)) {
    upsertComment({ kind: 'issue', ref: comment.item }, comment.marker, comment.body, source);
  }
  closeIssue(item, closure.kind === 'duplicate' ? 'duplicate' : 'completed');
}
