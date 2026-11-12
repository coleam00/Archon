/**
 * Claim the merge queue's items and read the facts the sweep decides from.
 *
 * Live claims, in intake's order, every item the build queue finished, up to `limit`,
 * and reads each pull request in one snapshot: its head, the trusted review
 * verdict, CI and review threads at that head, and whether it merges cleanly, beside
 * the latest validation the item's build rounds recorded. An item
 * whose pull request is already merged or closed, or that names none, is settled without
 * the sweep. An unreadable pull request waits once, then parks on a consecutive failed
 * read with the reason, without stopping the rest of the batch. Successful reads reset
 * that sequence durably before the sweep, keeping the claim until record settles it.
 * A red default branch reaches the sweep only with a pull request it holds back: with
 * nothing to decide there is nothing for it to block. An unreadable
 * base reaches record for independent bookkeeping before the run reports the failure.
 *
 * A pull request whose last decision stored the facts its wait can end on (`waitedOn`),
 * and whose facts read the same now, is released without the sweep: the agent would
 * decide the same. When that leaves nothing to decide, the run ends after its script nodes.
 */

import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { type QualifiedPr } from '../../.shared/identity.ts';
import { latestValidation, type Validation } from '../../.shared/build.ts';
import {
  itemPr,
  type CiMode,
  MERGE_PICKUP,
  listSetting,
  parseCiMode,
  parseLane,
  protectedChanges,
  type MergeRecord,
  type MergeSettled,
  type PrFacts,
  readBase,
  readPr,
  requireMergeSource,
  UNREADABLE,
  waitedOn,
  withMerge,
} from '../../.shared/merge.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { workflowRepo } from '../../.shared/remote.ts';
import { claimNext, updateClaimed, type Pickup, type WorkItem } from '../../.shared/workitem.ts';

interface Item {
  /** The issue whose work item the queue claimed. */
  readonly item: QualifiedPr;
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly facts: PrFacts;
  readonly record: MergeRecord | null;
  /** The latest validation its build rounds recorded, which the gate trusts under `ci: none`. */
  readonly validation: Validation | null;
  /** The changed paths the `protected_paths` setting matches; with any, the gate needs an approval at the head. */
  readonly protected: readonly string[];
}

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function claimAll(limit: number, runId: string, pickup: Pickup): WorkItem[] {
  const claimed: WorkItem[] = [];
  const at = new Date().toISOString();
  while (claimed.length < limit) {
    const doc = claimNext(at, runId, pickup);
    if (doc === null) break;
    claimed.push(doc);
  }
  return claimed;
}

type Snapshot = { readonly ok: true; readonly facts: PrFacts } | { readonly ok: false; readonly error: unknown };

function snapshotReader(maintainers: ReadonlySet<string>): (pr: QualifiedPr) => PrFacts {
  const snapshots = new Map<string, Snapshot>();
  return pr => {
    const key = JSON.stringify([pr.repo.host, pr.repo.path, pr.number]);
    let result = snapshots.get(key);
    if (result === undefined) {
      try {
        result = { ok: true, facts: readPr(pr, maintainers) };
      } catch (error) {
        result = { ok: false, error };
      }
      snapshots.set(key, result);
    }
    if (!result.ok) throw result.error;
    return result.facts;
  };
}

function unreadableItem(doc: WorkItem, pr: QualifiedPr | null, error: unknown): MergeSettled {
  const reason = `its pull request could not be read: ${error instanceof Error ? error.message : String(error)}`;
  const prior = doc.facts.merge;
  const consecutive = prior?.status === 'waiting' && prior.decisions.at(-1)?.decision === UNREADABLE;
  const status = consecutive ? 'parked' : 'waiting';
  return { item: doc.subject, pr, status, decision: UNREADABLE, reason };
}

function recordReadable(doc: WorkItem, facts: PrFacts, runId: string): WorkItem {
  if (doc.facts.merge?.decisions.at(-1)?.decision !== UNREADABLE) return doc;
  const at = new Date().toISOString();
  return updateClaimed(doc.subject, runId, current => withMerge(current, {
    at,
    run_id: runId,
    entry: { at, run_id: runId, decision: 'readable', reason: 'its pull request was read successfully', links: [], head: facts.head_revision, reran: false },
    status: 'waiting',
    pr: facts.pr,
    release: false,
  }));
}

type Inspection = { base: ReturnType<typeof readBase>; error: '' } | { base: null; error: string };

// The default branch is one of the facts a pull request is decided and waits on.
function inspectBase(repo: QualifiedPr['repo']): Inspection {
  try {
    return { base: readBase(repo), error: '' };
  } catch (error) {
    return { base: null, error: `merge-queue facts: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function emitFacts(
  inspection: Inspection,
  items: readonly Item[],
  settled: readonly MergeSettled[],
  unchanged: number,
  lane: string,
  ci: CiMode
): void {
  const { base } = inspection;
  if (unchanged > 0) console.error(`${String(unchanged)} pull request(s) read the same as at their last wait; not swept`);
  const path = base === null
    ? 'record'
    : items.length > 0
      ? 'sweep'
      : settled.length > 0 ? 'record' : 'idle';
  emit({
    path,
    base,
    base_error: inspection.error,
    items,
    settled,
    lane,
    ci,
  });
}

function main(): void {
  const limit = positive('limit', input('limit').trim());
  const ci = parseCiMode(input('ci').trim());
  const lane = parseLane('merge_lane', input('merge_lane').trim());
  const protectedPaths = listSetting(input('protected_paths'));
  const repo = workflowRepo();
  const runId = workflowRunId();

  requireMergeSource(repo);
  const snapshot = snapshotReader(readMaintainers(repo));
  const inspection = inspectBase(repo);
  const items: Item[] = [];
  const settled: MergeSettled[] = [];
  let unchanged = 0;
  for (const doc of claimAll(limit, runId, MERGE_PICKUP)) {
    let pr: QualifiedPr | null = null;
    let facts: PrFacts;
    try {
      pr = itemPr(doc);
      if (pr === null) {
        settled.push({ item: doc.subject, pr: null, status: 'parked', decision: 'parked', reason: 'the build record names no pull request' });
        continue;
      }
      facts = snapshot(pr);
    } catch (error) {
      settled.push(unreadableItem(doc, pr, error));
      continue;
    }
    const current = recordReadable(doc, facts, runId);
    if (facts.state !== 'open') {
      const status = facts.state === 'merged' ? 'merged' : 'parked';
      settled.push({ item: doc.subject, pr, status, decision: status, reason: `${facts.url} was ${facts.state} before this sweep` });
      continue;
    }
    if (current.facts.merge?.decisions.at(-1)?.waited_on === waitedOn(facts, inspection.base, ci)) {
      updateClaimed(doc.subject, runId, held => ({ ...held, claim: null }));
      unchanged += 1;
      continue;
    }
    items.push({
      item: doc.subject,
      pr,
      url: facts.url,
      facts,
      record: current.facts.merge ?? null,
      validation: latestValidation(current),
      protected: protectedChanges(pr, protectedPaths),
    });
  }
  emitFacts(inspection, items, settled, unchanged, lane, ci);
}

try {
  main();
} catch (error) {
  refuse(`merge-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
