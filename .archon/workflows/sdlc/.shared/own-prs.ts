/**
 * Enroll maintainers' own open pull requests in the merge queue.
 *
 * A maintainer whose maintainer-list entry sets `merge_queue: "own-prs"` gets each of
 * their open, non-draft pull requests a work item of its own, so a pull request they
 * opened by hand merges under the policy like one the build queue delivered. A pull
 * request a work item already names, through a build round or an earlier enrollment,
 * is left alone, and so is one on a build-queue branch: the build queue is delivering it,
 * and only it pushes there until it hands the pull request over as ready.
 */

import { isBuildBranch } from './build.ts';
import { note } from './io.ts';
import { MERGE_PICKUP, prFromUrl, itemPr, withMerge } from './merge.ts';
import { record, type QualifiedPr } from './forge.ts';
import { claimDisposition, runStatus, stateDocuments, stateGet, statePut } from './state.ts';
import {
  newWorkItem,
  read,
  type Read,
  released,
  type WorkItem,
  workItemName,
} from './workitem.ts';

/** The fields `gh pr list --json` selects, and the type each row carries for them. */
const OPEN_PR_FIELDS = { number: 'number', url: 'string', isDraft: 'boolean', headRefName: 'string' } as const;
type OpenPr = {
  readonly [Field in keyof typeof OPEN_PR_FIELDS]: { number: number; string: string; boolean: boolean }[(typeof OPEN_PR_FIELDS)[Field]];
};

function openPrsBy(repo: QualifiedPr['repo'], author: string): OpenPr[] {
  const fields = Object.keys(OPEN_PR_FIELDS) as (keyof typeof OPEN_PR_FIELDS)[];
  const result = Bun.spawnSync(
    ['gh', 'pr', 'list', '--repo', `${repo.host}/${repo.path}`, '--state', 'open', '--author', author, '--json', fields.join(','), '--limit', '100'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(`gh pr list failed: ${result.stderr.toString().trim()}`);
  const rows: unknown = JSON.parse(result.stdout.toString());
  if (!Array.isArray(rows)) throw new Error('gh pr list did not report a list');
  return rows.map(row => {
    const fieldsOf = record(row);
    const missing = fields.filter(field => typeof fieldsOf?.[field] !== OPEN_PR_FIELDS[field]);
    if (missing.length > 0) throw new Error(`gh pr list reported a pull request without ${missing.join(', ')}`);
    return fieldsOf as OpenPr;
  });
}

/** A pull request's identity across repositories: the same number in two repositories is two pull requests. */
function prKey(pr: QualifiedPr): string {
  return `${pr.repo.host}/${pr.repo.path}#${String(pr.number)}`;
}

/**
 * The pull requests some work item already names, and the work items themselves. A
 * malformed item is noted and skipped, as the pickup skips it.
 */
function namedPrs(): Set<string> {
  const named = new Set<string>();
  for (const { name, doc } of stateDocuments('work/').flatMap(stored => read(stored.name, stored) ?? [])) {
    named.add(prKey(doc.subject));
    try {
      const pr = ownedPr(doc);
      if (pr !== null) named.add(prKey(pr));
    } catch (error) {
      skipped('own-PR enrollment', name, error);
    }
  }
  return named;
}

/**
 * The pull request a work item owns now: a build item's latest round's, which may name
 * none, or an enrolled own pull request. Merge routing reads `itemPr` instead.
 */
function ownedPr(doc: WorkItem): QualifiedPr | null {
  const build = doc.facts.build;
  const url = build === undefined ? doc.facts.own_pr?.url : build.rounds.at(-1)?.pr_url;
  return url === undefined || url === '' ? null : prFromUrl(url);
}

/** An enrolled own pull request that no build round has taken over since. */
export function isOwnPr(doc: WorkItem): boolean {
  return doc.facts.own_pr !== undefined && doc.facts.build === undefined;
}

/** Create a work item for each own pull request no work item names; returns their numbers. */
export function enrollOwnPrs(repo: QualifiedPr['repo'], authors: ReadonlySet<string>, at: string): number[] {
  if (authors.size === 0) return [];
  const named = namedPrs();
  const enrolled: number[] = [];
  for (const author of authors) {
    const listed = openPrsBy(repo, author).filter(pr => !pr.isDraft && !isBuildBranch(pr.headRefName));
    for (const pr of listed) {
      const subject = prFromUrl(pr.url);
      if (named.has(prKey(subject))) continue;
      const name = workItemName(subject.number);
      const stored = stateGet(name);
      if (stored.value !== null) continue;
      const doc = { ...newWorkItem(subject, at), facts: { own_pr: { url: pr.url, at } } };
      if (statePut(name, doc, stored.revision) === 'ok') enrolled.push(subject.number);
    }
  }
  return enrolled;
}

/** A build item's takeover of an own-PR item's pull request. */
export interface Takeover {
  readonly pr: QualifiedPr;
  readonly builder: number;
}

export const SUPERSEDED = 'superseded';

export function supersededReason({ pr, builder }: Takeover): string {
  return `${SUPERSEDED}: the build queue delivers ${pr.repo.path}#${String(pr.number)} under work item ${String(builder)}`;
}

/**
 * Settle each own-PR item whose pull request a build item's latest round names, before
 * the pickup claims anything. The build item owns the pull request; the settled item
 * stays on record with the reason and no longer waits for the merge queue. A merged
 * one stays merged. A claim whose run ended is released in the settling write, as the
 * pickup would release it; a live or unknown claim is held, and its run still owns the
 * item. A malformed item is noted and skipped. Returns the takeover of a work item,
 * or null, for the pickup to settle an item whose claim ended after this pass.
 */
export function supersedeOwnPrs(at: string, runId: string): (doc: WorkItem) => Takeover | null {
  const items = stateDocuments('work/').flatMap(stored => read(stored.name, stored) ?? []);
  const builders = buildersOf(items);
  const takeover = (doc: WorkItem, pr: QualifiedPr | null): Takeover | null => {
    const builder = pr === null ? undefined : builders.get(prKey(pr));
    return pr === null || builder === undefined || builder === doc.subject.number ? null : { pr, builder };
  };
  for (const item of items) {
    const found = takeover(item.doc, ownPrOf(item));
    if (found !== null) supersede(item, found, at, runId);
  }
  return doc => {
    if (!supersedable(doc)) return null;
    try {
      return takeover(doc, itemPr(doc));
    } catch {
      // An unparsable URL is no takeover; the pickup reads the same URL and settles the item unreadable.
      return null;
    }
  };
}

function skipped(what: string, name: string, error: unknown): void {
  note(`${what} skips ${name}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * The pull request each build item delivers now, its latest round's, to that item's
 * number. An earlier round's pull request is no longer the build item's.
 */
function buildersOf(items: readonly Read[]): Map<string, number> {
  const builders = new Map<string, number>();
  for (const { name, doc } of items) {
    if (doc.facts.build === undefined) continue;
    try {
      const pr = ownedPr(doc);
      if (pr !== null) builders.set(prKey(pr), doc.subject.number);
    } catch (error) {
      skipped('own-PR supersession', name, error);
    }
  }
  return builders;
}

/** An own-PR item a build item can take over: a merged one is settled for good. */
function supersedable(doc: WorkItem): boolean {
  return isOwnPr(doc) && doc.facts.merge?.status !== 'merged';
}

/** The pull request of an own-PR item, or null for any other item or one whose URL does not parse. */
function ownPrOf(item: Read): QualifiedPr | null {
  if (!supersedable(item.doc)) return null;
  try {
    return itemPr(item.doc);
  } catch (error) {
    skipped('own-PR supersession', item.name, error);
    return null;
  }
}

/** Whether the item is already parked with this supersession. */
function recordsSupersession(doc: WorkItem, reason: string): boolean {
  // The reason is supersede's own record of the builder, so equality is the check.
  const last = doc.facts.merge?.decisions.at(-1);
  return doc.facts.merge?.status === 'parked' && last?.decision === SUPERSEDED && last.reason === reason;
}

/**
 * Record the supersession, re-reading on a conflict so a concurrent write is kept. False
 * when a live claim holds the item or it already records this supersession.
 */
function supersede(item: Read, takeover: Takeover, at: string, runId: string): boolean {
  const reason = supersededReason(takeover);
  let current: Read | undefined = item;
  for (let attempt = 0; attempt < 3 && current !== undefined && supersedable(current.doc); attempt++) {
    if (recordsSupersession(current.doc, reason)) return false;
    // An ended run's claim is released in the same write that settles the item, so the
    // pickup never sees it unclaimed and unsettled.
    const claim = current.doc.claim;
    const status = claim === null ? null : runStatus(claim.run_id);
    if (claim !== null && claimDisposition(status) === 'hold') return false;
    const doc = claim === null ? current.doc : released(current.doc, claim, status, at, runId, MERGE_PICKUP);
    const entry = { at, run_id: runId, decision: SUPERSEDED, reason, links: [], head: null, reran: false };
    const next = withMerge(doc, { at, run_id: runId, entry, status: 'parked', pr: takeover.pr, release: false });
    if (statePut(current.name, next, current.revision) === 'ok') return true;
    current = read(item.name);
  }
  if (current === undefined || !supersedable(current.doc)) return false;
  throw new Error(`${item.name} kept changing: three supersession writes conflicted`);
}
