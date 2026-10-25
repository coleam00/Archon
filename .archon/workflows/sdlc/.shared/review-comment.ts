/**
 * The pull request's canonical review comment: the one comment publish-review writes
 * and edits in place, and the merge queue's gate reads.
 *
 * Its first lines are stamped by the publishing script from the round's certified
 * output, never by the report's author: the marker, the commit the round reviewed, the
 * verdict and the contract coverage (`complete` when the review left nothing open). The
 * report follows as prose for people, and nothing parses it.
 */

export const REVIEW_MARKER = '<!-- archon-review-report -->';

export const CONTRACT_COVERAGES = ['complete', 'open'] as const;
export type ContractCoverage = (typeof CONTRACT_COVERAGES)[number];

export function reviewCommentBody(head: string, ready: boolean, contract: ContractCoverage, report: string): string {
  return `${REVIEW_MARKER}\nReviewed commit: \`${head}\`\nVerdict: ${ready ? 'ready' : 'not ready'}\nContract: ${contract}\n\n${report}`;
}

export interface ReviewStamp {
  readonly reviewed: string;
  /** Null for a comment published before the verdict was stamped. */
  readonly ready: boolean | null;
  /** Null for a comment published before coverage was stamped. */
  readonly contract: ContractCoverage | null;
  readonly report: string;
}

/** The stamp of a review comment; null when the body is not one. */
export function readReviewStamp(body: string): ReviewStamp | null {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== REVIEW_MARKER) return null;
  const reviewed = /^Reviewed commit: `([0-9a-f]{7,64})`$/.exec(lines[1] ?? '')?.[1];
  if (reviewed === undefined) return null;
  const verdict = /^Verdict: (ready|not ready)$/.exec(lines[2] ?? '')?.[1];
  const stamped = verdict === undefined ? undefined : /^Contract: (\S+)$/.exec(lines[3] ?? '')?.[1];
  const contract = CONTRACT_COVERAGES.find(coverage => coverage === stamped) ?? null;
  const rest = lines.slice(2 + (verdict === undefined ? 0 : 1) + (contract === null ? 0 : 1)).join('\n');
  return {
    reviewed,
    ready: verdict === undefined ? null : verdict === 'ready',
    contract,
    report: rest.replace(/^\n+/, ''),
  };
}
