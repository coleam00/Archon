import type { BlockerRef, Issue } from "./types.js";

export interface RawLinearIssue {
  id: string;
  identifier: string;
  title?: string | null;
  description?: string | null;
  priority?: number | string | null;
  branchName?: string | null;
  url?: string | null;
  state?: { name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null }> } | null;
  inverseRelations?: {
    nodes?: Array<{
      type?: string | null;
      issue?: {
        id?: string | null;
        identifier?: string | null;
        state?: { name?: string | null } | null;
      } | null;
    }>;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export function normalizeLinearIssue(raw: RawLinearIssue): Issue {
  const stateName = raw.state?.name ?? "";

  const labelNodes = raw.labels?.nodes ?? [];
  const labels = labelNodes
    .map((n) => (typeof n?.name === "string" ? n.name.toLowerCase() : null))
    .filter((s): s is string => !!s);

  const blockedNodes = raw.inverseRelations?.nodes ?? [];
  const blocked_by: BlockerRef[] = blockedNodes
    .filter((rel) => rel?.type === "blocks")
    .map((rel) => rel?.issue)
    .filter((i): i is { id: string; identifier: string; state: { name?: string | null } | null } =>
      !!i && typeof i.id === "string" && typeof i.identifier === "string",
    )
    .map((i) => ({
      id: i.id,
      identifier: i.identifier,
      state: i.state?.name ?? "",
    }));

  let priority: number | null = null;
  if (typeof raw.priority === "number" && Number.isInteger(raw.priority)) {
    priority = raw.priority;
  }

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : null,
    priority,
    state: stateName,
    branch_name: typeof raw.branchName === "string" ? raw.branchName : null,
    url: typeof raw.url === "string" ? raw.url : null,
    labels,
    blocked_by,
    created_at: parseDate(raw.createdAt),
    updated_at: parseDate(raw.updatedAt),
  };
}

function parseDate(input: unknown): Date | null {
  if (typeof input !== "string") return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}
