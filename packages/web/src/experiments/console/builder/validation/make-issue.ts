/**
 * Shared issue factory — the only construction site for `IssueId`. Computes a
 * stable `Issue.id` from (rule, path, message) so the same finding keeps the
 * same id across re-validations and can be deduped.
 *
 * Because `message` participates in the hash, editing an issue's message text
 * changes its id. That is harmless while issues live only in client memory,
 * but once issues are persisted or served by a server tier (PR-3), message
 * copy edits will invalidate stored ids — coordinate copy changes accordingly.
 */
import type { Issue, IssueId } from '../types';

/** FNV-1a 32-bit hash → 8-hex-char string. Pure, deterministic, no deps. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Build a complete `Issue` with a stable id derived from its identifying fields. */
export function makeIssue(input: Omit<Issue, 'id'>): Issue {
  const { rule, path, message } = input;
  // JSON.stringify is lossless: a '|' join would collide when a field contains '|'.
  const key = JSON.stringify([
    rule,
    path.nodeId ?? '',
    path.field ?? '',
    path.atomIndex ?? '',
    message,
  ]);
  return { ...input, id: `${rule}:${fnv1a(key)}` as IssueId };
}
