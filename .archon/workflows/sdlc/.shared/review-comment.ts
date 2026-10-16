/**
 * The pull request's canonical review comment: the one comment publish-review writes
 * and edits in place, and the merge queue's gate reads.
 *
 * Its first three lines are stamped by the publishing script from the round's certified
 * output, never by the report's author: the marker, the commit the round reviewed and
 * the verdict. The report follows as prose for people, and nothing parses it.
 */

export const REVIEW_MARKER = '<!-- archon-review-report -->';

export function reviewCommentBody(head: string, ready: boolean, report: string): string {
  return `${REVIEW_MARKER}\nReviewed commit: \`${head}\`\nVerdict: ${ready ? 'ready' : 'not ready'}\n\n${report}`;
}

export interface ReviewStamp {
  readonly reviewed: string;
  /** Null for a comment published before the verdict was stamped. */
  readonly ready: boolean | null;
  readonly report: string;
}

/** The stamp of a review comment; null when the body is not one. */
export function readReviewStamp(body: string): ReviewStamp | null {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== REVIEW_MARKER) return null;
  const reviewed = /^Reviewed commit: `([0-9a-f]{7,64})`$/.exec(lines[1] ?? '')?.[1];
  if (reviewed === undefined) return null;
  const verdict = /^Verdict: (ready|not ready)$/.exec(lines[2] ?? '')?.[1];
  const rest = lines.slice(verdict === undefined ? 2 : 3).join('\n');
  return {
    reviewed,
    ready: verdict === undefined ? null : verdict === 'ready',
    report: rest.replace(/^\n+/, ''),
  };
}
