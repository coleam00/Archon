import { parseQualifiedPr, record, type QualifiedPr } from './forge.ts';

/** The pull request delivery recorded, when the scope is that JSON record. */
export function recordedReviewPr(scope: string): QualifiedPr | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    return undefined; // a PR URL, a branch name, or empty
  }
  return record(parsed) ? parseQualifiedPr(scope) : undefined;
}
