/**
 * Claim the merge queue's items and read the facts the sweep decides from.
 *
 * Live claims, in intake's order, every item the build queue finished, up to `limit`,
 * and reads each one's pull request in one snapshot: its head, the trusted review
 * verdict, CI and review threads at that head, and whether it merges cleanly. The
 * trusted review report is written under `merge/<number>/review/` with the commit it
 * reviewed beside it, so a delta review can continue from it. An item whose pull
 * request is already merged or closed, or that names none, is settled without the
 * sweep, and one whose pull request cannot be read waits for the next sweep with the
 * reason, so it never stops the rest of the batch. It writes only the claims.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, text, trimmed } from '../../.shared/io.ts';
import {
  itemPr,
  MERGE_METHODS,
  MERGE_PICKUP,
  type MergeMethod,
  type MergeRecord,
  type MergeSettled,
  type PrFacts,
  type PrRead,
  readBase,
  readPr,
  requireGh,
  UNREADABLE,
} from '../../.shared/merge.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { claimNext, parseOrder, readMaintainers, type WorkItem } from '../../.shared/workitem.ts';

interface Item {
  /** The issue whose work item the queue claimed. */
  readonly item: QualifiedPr;
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly facts: PrFacts;
  readonly record: MergeRecord | null;
  /** The trusted review report a delta review continues from; empty when there is none. */
  readonly prior_report: string;
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

function writePrior(pr: QualifiedPr, reviewed: string, report: string): string {
  const dir = join(artifactsDir(), 'merge', String(pr.number), 'review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), report);
  writeFileSync(join(dir, 'reviewed-head'), `${reviewed}\n`);
  return join(dir, 'report.md');
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

function main(): void {
  const limit = positive('limit', trimmed(process.env.INPUTS_LIMIT));
  const order = parseOrder(text(process.env.INPUTS_ORDER));
  const method = parseMethod(trimmed(process.env.INPUTS_MERGE_METHOD));
  const repo = { host: trimmed(process.env.INPUTS_REPO_HOST), path: trimmed(process.env.INPUTS_REPO_PATH) };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  requireGh();
  const maintainers = readMaintainers(repo);
  const items: Item[] = [];
  const settled: MergeSettled[] = [];
  for (const doc of claimAll(limit, order, runId)) {
    let pr: QualifiedPr | null = null;
    let read: PrRead;
    try {
      pr = itemPr(doc);
      if (pr === null) {
        settled.push({ item: doc.subject, pr: null, status: 'parked', decision: 'parked', reason: 'the build record names no pull request' });
        continue;
      }
      read = readPr(pr, maintainers);
    } catch (error) {
      const reason = `its pull request could not be read: ${error instanceof Error ? error.message : String(error)}`;
      settled.push({ item: doc.subject, pr, status: 'waiting', decision: UNREADABLE, reason });
      continue;
    }
    const { facts, report } = read;
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
      record: doc.facts.merge ?? null,
      prior_report: report === null || facts.verdict.reviewed === null ? '' : writePrior(pr, facts.verdict.reviewed, report),
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
  emit({
    path: items.length > 0 ? 'sweep' : settled.length > 0 ? 'record' : 'idle',
    base: items.length > 0 ? readBase(repo) : null,
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
