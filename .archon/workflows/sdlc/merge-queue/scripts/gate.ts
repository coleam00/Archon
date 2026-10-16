/**
 * The merge queue's gate: the sweep agent's one way to merge.
 *
 *   gate.ts --method <squash|merge> --receipts <dir> --pr <url> --head <sha> [--merge]
 *
 * It reads the pull request fresh and refuses unless the trusted review verdict says
 * Ready at `head`, CI is green at `head`, no review thread is unresolved, and the pull
 * request is open, not a draft, into the default branch and still at `head`. Without
 * `--merge` it only reports. With it, a passing gate merges pinned to `head`, reads the
 * merge back and writes a receipt the record node checks: a pull request the sweep
 * says it merged must carry one.
 *
 * Prints one JSON document: `{pr, head, refusals, merge_commit}`. A refused merge or a
 * failed one exits nonzero.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, refuse } from '../../.shared/io.ts';
import {
  gateRefusals,
  MERGE_METHODS,
  mergePinned,
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
  const commit = mergePinned(pr, head, method, maintainers);
  const receipt: Receipt = { pr: url, head, merge_commit: commit, at: new Date().toISOString() };
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, `${String(pr.number)}.json`), `${JSON.stringify(receipt)}\n`);
  emit({ pr: url, head, refusals, merge_commit: commit });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue gate: ${error instanceof Error ? error.message : String(error)}`);
}
