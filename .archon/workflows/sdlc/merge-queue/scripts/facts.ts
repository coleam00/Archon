/**
 * Claim the merge queue's items and read the facts the sweep decides from.
 *
 * Enrolls listed maintainers' own open pull requests that opted in (`maintainers.ts`), then
 * live claims, in intake's order, every item the build queue finished, up to `limit`,
 * and reads each one's pull request in one snapshot: its head, the trusted review
 * verdict, CI and review threads at that head, and whether it merges cleanly. An item
 * whose pull request is already merged or closed, or that names none, is settled without
 * the sweep. An unreadable pull request waits once, then parks on a consecutive failed
 * read with the reason, without stopping the rest of the batch. Successful reads reset
 * that sequence durably before the sweep, keeping the claim until record settles it.
 * A red default branch reaches the sweep even when no pull request waits.
 */

import { join } from 'node:path';
import type { QualifiedPr } from '../../.shared/forge.ts';
import { emit, note, refuse, text, trimmed } from '../../.shared/io.ts';
import {
  itemPr,
  MERGE_METHODS,
  MERGE_PICKUP,
  type MergeMethod,
  type MergeRecord,
  type MergeSettled,
  type PrFacts,
  readBase,
  readPr,
  requireGh,
  UNREADABLE,
  withMerge,
} from '../../.shared/merge.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { readMaintainerList } from '../../.shared/maintainers.ts';
import { enrollOwnPrs, isOwnPr } from '../../.shared/own-prs.ts';
import { claimNext, parseOrder, updateClaimed, type WorkItem } from '../../.shared/workitem.ts';

interface Item {
  /** The issue whose work item the queue claimed. */
  readonly item: QualifiedPr;
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly facts: PrFacts;
  readonly record: MergeRecord | null;
  /** A maintainer's own pull request the queue enrolled: no issue and no build round behind it. */
  readonly own_pr: boolean;
}

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseMethod(value: string): MergeMethod {
  const method = MERGE_METHODS.find(candidate => candidate === value);
  if (method === undefined) throw new Error(`merge_method must be one of ${MERGE_METHODS.join(', ')}, not "${value}"`);
  return method;
}

/** A shell word: the sweep pastes the gate command into its shell. */
function quoted(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function claimAll(limit: number, order: ReturnType<typeof parseOrder>, runId: string): WorkItem[] {
  const claimed: WorkItem[] = [];
  const at = new Date().toISOString();
  while (claimed.length < limit) {
    const doc = claimNext(order, at, runId, MERGE_PICKUP);
    if (doc === null) break;
    claimed.push(doc);
  }
  return claimed;
}

/**
 * Enrollment only adds work items, so a failed listing must not stop the sweep merging
 * the ones that already exist. Items enrolled before the failure are kept.
 */
function enrollOrNote(repo: QualifiedPr['repo'], authors: ReadonlySet<string>): void {
  try {
    enrollOwnPrs(repo, authors, new Date().toISOString());
  } catch (error) {
    note(`merge-queue facts: own-PR enrollment stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function main(): void {
  const limit = positive('limit', trimmed(process.env.INPUTS_LIMIT));
  const order = parseOrder(text(process.env.INPUTS_ORDER));
  const method = parseMethod(trimmed(process.env.INPUTS_MERGE_METHOD));
  const repo = { host: trimmed(process.env.INPUTS_REPO_HOST), path: trimmed(process.env.INPUTS_REPO_PATH) };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  requireGh();
  const list = readMaintainerList(repo);
  const maintainers = list.logins;
  enrollOrNote(repo, list.ownPrs);
  const items: Item[] = [];
  const settled: MergeSettled[] = [];
  for (const doc of claimAll(limit, order, runId)) {
    let pr: QualifiedPr | null = null;
    let facts: PrFacts;
    try {
      pr = itemPr(doc);
      if (pr === null) {
        settled.push({ item: doc.subject, pr: null, status: 'parked', decision: 'parked', reason: 'the build record names no pull request' });
        continue;
      }
      facts = readPr(pr, maintainers);
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
    items.push({
      item: doc.subject,
      pr,
      url: facts.url,
      facts,
      record: current.facts.merge ?? null,
      own_pr: isOwnPr(doc),
    });
  }
  const gate = [
    process.execPath,
    join(import.meta.dir, 'gate.ts'),
    '--method',
    method,
  ]
    .map(quoted)
    .join(' ');
  // The default branch is read on every run: a red one after the last merge needs the
  // sweep's question even when no pull request waits.
  const base = readBase(repo);
  const sweep = items.length > 0 || base.checks.state === 'red';
  emit({
    path: sweep ? 'sweep' : settled.length > 0 ? 'record' : 'idle',
    base,
    items,
    settled,
    gate,
    policy_defaults: POLICY_DEFAULTS,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
