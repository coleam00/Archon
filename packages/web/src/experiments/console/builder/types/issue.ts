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

/** A single validation finding. `id` is a stable hash of (rule, path, message). */
export interface Issue {
  id: string;
  rule: string;
  severity: Severity;
  source: IssueSource;
  message: string;
  path: IssuePath;
}
