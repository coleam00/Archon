/**
 * The factory's generic reads, for the map and the board cards: a pack's factory view, run
 * records without events, and what the project's forge says of issues and changes. Types come
 * from the generated API; nothing here knows a pack's words.
 */
import type { components, paths } from '@/lib/api.generated';
import { HttpError, requestJson } from '../lib/http';

export type PackView = components['schemas']['PackView'];
export type FactoryView = NonNullable<PackView['view']>;
/** The How it works picture of a factory view. */
export type HowItWorks = FactoryView['howItWorks'];
export type RunRecords = components['schemas']['RunRecords'];
export type RunRecord = RunRecords['records'][number];
export type ForgeSubjects = components['schemas']['ForgeSubjects'];

/** At most this many runs, or issues and changes, per read: what the two routes take. */
export const READ_MAX = 100;

/**
 * The one read of the factory view a pack ships, whole: its path (null when the pack ships
 * none), the view (null when the file does not read) and its problems against the graph. The
 * map chooses curated or derived from all three (`lib/map-source.ts`); board cards read `.view`.
 */
export async function getPackViewRead(projectId: string, pack: string): Promise<PackView> {
  return requestJson('/api/packs/{pack}/view', 'get', {
    params: { pack },
    query: { codebaseId: projectId },
  });
}

function refusal(body: string): { error?: string; detail?: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { error, detail } = parsed as Record<string, unknown>;
    return {
      ...(typeof error === 'string' ? { error } : {}),
      ...(typeof detail === 'string' ? { detail } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * A GET whose query repeats a parameter once per value, which the console's request helper
 * cannot send (it joins an array into one value), so this builds the query itself and fails
 * the way that helper does.
 */
async function getRepeated<T>(path: keyof paths, query: URLSearchParams): Promise<T> {
  const res = await fetch(`${path}?${query.toString()}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const { error, detail } = refusal(body);
    const snippet = body.length > 200 ? `${body.slice(0, 200)}...` : body;
    throw new HttpError(res.status, path, snippet, error, detail);
  }
  return (await res.json()) as T;
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += READ_MAX) out.push(list.slice(at, at + READ_MAX));
  return out;
}

/** Which top-level fields of each node's output and of the result a records read keeps. */
export interface RecordFields {
  output: readonly string[];
  result: readonly string[];
}

/**
 * The records of `ids`, read `READ_MAX` at a time and merged. A run listed `missing` or
 * `unreadable` in any part stays listed, so a caller never takes an absent record for none.
 */
export async function getRunRecords(
  ids: readonly string[],
  fields: RecordFields
): Promise<RunRecords> {
  const parts = await Promise.all(
    chunks(ids).map(part => {
      const query = new URLSearchParams();
      for (const id of part) query.append('runId', id);
      for (const key of fields.output) query.append('outputKey', key);
      for (const key of fields.result) query.append('resultKey', key);
      return getRepeated<RunRecords>('/api/workflows/runs/records', query);
    })
  );
  return {
    records: parts.flatMap(part => part.records),
    missing: parts.flatMap(part => part.missing),
    unreadable: parts.flatMap(part => part.unreadable),
  };
}

/** What the forge is asked about: issue numbers, and changes runs named at a URL. */
export interface ForgeQuery {
  codebaseId: string;
  issues: readonly number[];
  changes: readonly { run: string; url: string }[];
}

/**
 * Whether the forge left anything pending: a first lookup the server could not finish in time
 * answers `pending` for that read only, so the caller reads again (`FactoryCards.tsx`).
 */
export const forgePending = (subjects: ForgeSubjects): boolean =>
  subjects.issues.some(issue => issue.pending) ||
  subjects.changes.some(change => change.merged === 'pending');

/** What the project's forge says of some issues and changes, `READ_MAX` asks per request. */
export async function getForgeSubjects(opts: ForgeQuery): Promise<ForgeSubjects> {
  type Ask = { issue: number } | { run: string; url: string };
  const asks: Ask[] = [
    ...opts.issues.map(issue => ({ issue })),
    ...opts.changes.map(change => ({ ...change })),
  ];
  const parts = await Promise.all(
    chunks(asks).map(part => {
      const query = new URLSearchParams({ codebaseId: opts.codebaseId });
      for (const ask of part)
        if ('issue' in ask) query.append('issue', String(ask.issue));
        else {
          query.append('changeRun', ask.run);
          query.append('changeUrl', ask.url);
        }
      return getRepeated<ForgeSubjects>('/api/forge/subjects', query);
    })
  );
  return {
    issues: parts.flatMap(part => part.issues),
    changes: parts.flatMap(part => part.changes),
  };
}
