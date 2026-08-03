/**
 * Validation issue types. Issues surface via return values from the validation
 * pure functions — never thrown, never logged.
 */

/** Issue severity. */
export type Severity = 'error' | 'warning' | 'info';

/**
 * Which validation tier produced the issue. `'server'` is type-only in PR-1
 * (the server tier wires in PR-3); the client tiers run synchronously here.
 */
export type IssueSource = 'client-instant' | 'client-debounced' | 'server';

/** Locates an issue within the workflow (all optional — graph-level issues omit them). */
export interface IssuePath {
  nodeId?: string;
  field?: string;
  atomIndex?: number;
}

declare const ISSUE_ID_BRAND: unique symbol;

/**
 * Branded issue id. Constructing one outside `makeIssue` is a compile error,
 * so every `Issue.id` in the system is guaranteed to be the stable
 * (rule, path, message) hash that dedup and cross-render identity rely on.
 */
export type IssueId = string & { readonly [ISSUE_ID_BRAND]: true };

/** A single validation finding. `id` is a stable hash of (rule, path, message). */
export interface Issue {
  id: IssueId;
  rule: string;
  severity: Severity;
  source: IssueSource;
  message: string;
  path: IssuePath;
}
