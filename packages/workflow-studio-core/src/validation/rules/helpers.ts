import { type Issue, issueId, type Severity, type RuleSource } from '../types';

/**
 * Shared issue factory for all rule modules.
 *
 * The `issueId` hash is keyed on (rule, path, message) only — severity and
 * source do NOT affect the hash, so changing a rule's severity or source
 * tag will not invalidate existing stored issue IDs.
 */
export function mk(
  rule: string,
  severity: Severity,
  source: RuleSource,
  path: Issue['path'],
  message: string
): Issue {
  return {
    id: issueId(rule, path, message),
    rule,
    severity,
    source,
    message,
    path,
  };
}
