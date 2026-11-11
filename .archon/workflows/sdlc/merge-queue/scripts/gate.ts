/**
 * The merge queue's gate: the sweep agent's one way to merge.
 *
 *   gate.ts --method <squash|merge> --ci <forge|none> --item <number> --pr <url> --head <sha> [--merge]
 *
 * It reads the pull request and the default branch fresh and refuses unless the trusted
 * review verdict says Ready at `head`, what the `ci` setting trusts passes at `head`
 * (green checks under `forge`; under `none`, a passing validation the issue `--item`'s
 * build rounds recorded at `head`), the default branch's CI is not red, and the pull
 * request is open, not a draft, into the default branch, still at `head`, and `head`
 * contains the default branch's head or the forge reports it merges cleanly. Without
 * `--merge` it only reports. With it, a passing gate merges pinned to `head` and reports
 * the commit the forge's own read-back says it landed as. A merge the forge cannot
 * verify, as on a branch whose merges it queues, fails the gate with the forge's
 * outcome. The record node is the one place that settles each pull request against the
 * forge.
 *
 * Prints one JSON document: `{pr, head, refusals, merge_commit}`. A refused merge or a
 * failed one exits nonzero.
 */

import { emit, refuse } from 'archon:script';
import { latestValidation } from '../../.shared/build.ts';
import { type CiTrust, gateRefusals, MERGE_METHODS, mergeAtHead, parseCiMode, readBase, readPr } from '../../.shared/merge.ts';
import { prFromUrl } from '../../.shared/pr.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { read, workItemName } from '../../.shared/workitem.ts';

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

/** What the `ci` setting trusts, read fresh: under `none`, the item's recorded validation. */
function ciTrust(args: readonly string[]): CiTrust {
  const mode = parseCiMode(flag(args, '--ci'));
  if (mode === 'forge') return { mode };
  const item = Number(flag(args, '--item'));
  if (!Number.isInteger(item) || item <= 0) throw new Error('--item must be the issue number');
  const stored = read(workItemName(item));
  if (stored === undefined) throw new Error(`issue ${String(item)} has no work item`);
  return { mode, validation: latestValidation(stored.doc) };
}

function main(): void {
  const args = process.argv.slice(2);
  const method = MERGE_METHODS.find(candidate => candidate === flag(args, '--method'));
  if (method === undefined) throw new Error(`--method must be one of ${MERGE_METHODS.join(', ')}`);
  const url = flag(args, '--pr');
  const head = flag(args, '--head');
  const merge = args.includes('--merge');
  const pr = prFromUrl(url);
  const ci = ciTrust(args);
  const refusals = gateRefusals(readPr(pr, readMaintainers(pr.repo)), head, readBase(pr.repo), ci);
  if (!merge || refusals.length > 0) {
    emit({ pr: url, head, refusals, merge_commit: null });
    if (merge) process.exitCode = 1;
    return;
  }
  const commit = mergeAtHead(pr, head, method);
  emit({ pr: url, head, refusals, merge_commit: commit });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue gate: ${error instanceof Error ? error.message : String(error)}`);
}
