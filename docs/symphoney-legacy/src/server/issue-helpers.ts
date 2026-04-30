import type { Issue } from "../tracker/types.js";

/**
 * Convert an internal {@link Issue} to a JSON-safe shape: `Date` fields become
 * ISO strings so the HTTP layer never leaks `Date` instances to clients.
 */
export function serializeIssue(i: Issue): {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: { id: string; identifier: string; state: string }[];
  created_at: string | null;
  updated_at: string | null;
} {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description,
    priority: i.priority,
    state: i.state,
    branch_name: i.branch_name,
    url: i.url,
    labels: i.labels,
    blocked_by: i.blocked_by,
    created_at: i.created_at ? i.created_at.toISOString() : null,
    updated_at: i.updated_at ? i.updated_at.toISOString() : null,
  };
}
