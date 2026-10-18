/**
 * The merge queue's gate: the sweep agent's one way to merge.
 *
 *   gate.ts --method <squash|merge> --receipts <dir> --pr <url> --head <sha> [--merge]
 *
 * It reads the pull request fresh and refuses unless the trusted review verdict says
 * Ready at `head`, CI is green at `head`, no review thread is unresolved, and the pull
 * request is open, not a draft, into the default branch, still at `head`, and `head`
 * contains the default branch's head. Without
 * `--merge` it only reports. With it, a passing gate merges pinned to `head`, writes a
 * receipt as soon as the forge accepts the merge, and reads the merge back. A pull
 * request that reads back unmerged, as on a branch whose merges the forge queues, loses
 * its receipt and fails the gate. A receipt tells the record node this run made the
 * merge; the forge's read-back, not the receipt, says whether it merged.
 *
 * Prints one JSON document: `{pr, head, refusals, merge_commit}`. A refused merge or a
 * failed one exits nonzero; a merge whose read-back itself failed says it was made.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, refuse } from '../../.shared/io.ts';
import {
  gateRefusals,
  MERGE_METHODS,
  mergeAtHead,
  mergeCommitAt,
  type PrFacts,
  prFromUrl,
  type Receipt,
  readPr,
  requireGh,
} from '../../.shared/merge.ts';
import { readMaintainers } from '../../.shared/workitem.ts';

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const method = MERGE_METHODS.find(candidate => candidate === flag(args, '--method'));
  if (method === undefined) throw new Error(`--method must be one of ${MERGE_METHODS.join(', ')}`);
  const receipts = flag(args, '--receipts');
  const url = flag(args, '--pr');
  const head = flag(args, '--head');
  const merge = args.includes('--merge');
  requireGh();
  const pr = prFromUrl(url);
  const maintainers = readMaintainers(pr.repo);
  const refusals = gateRefusals(readPr(pr, maintainers).facts, head);
  if (!merge || refusals.length > 0) {
    emit({ pr: url, head, refusals, merge_commit: null });
    if (merge) process.exitCode = 1;
    return;
  }
  mergeAtHead(pr, head, method);
  const receipt: Receipt = { pr: url, head, at: new Date().toISOString() };
  const receiptPath = join(receipts, `${String(pr.number)}.json`);
  mkdirSync(receipts, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  let after: PrFacts;
  try {
    after = readPr(pr, maintainers).facts;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`merged ${url} at ${head}, so declare it merged, but the read-back failed: ${reason}`);
  }
  const commit = mergeCommitAt(after, head);
  if (commit === null) {
    rmSync(receiptPath);
    throw new Error(
      `the forge accepted the merge of ${url} at ${head}, but it reads back ${after.state} at ${after.head_revision}, so it did not merge`
    );
  }
  emit({ pr: url, head, refusals, merge_commit: commit });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue gate: ${error instanceof Error ? error.message : String(error)}`);
}
