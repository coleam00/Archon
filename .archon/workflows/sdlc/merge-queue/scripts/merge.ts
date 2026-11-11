/**
 * The merge queue's gate and its one merge: the sweep agent decides, this script merges.
 *
 * For each pull request the sweep declared `merge`, in its order, it reads the pull
 * request and the default branch fresh and refuses unless the trusted review verdict
 * says Ready at the declared head, what the `ci` setting trusts passes there (green
 * checks under `forge`; under `none`, a passing validation the item's build rounds
 * recorded at that head), the default branch's CI is not red, and the pull request is
 * open, not a draft, into the default branch, still at that head, and the head contains
 * the default branch's head or the forge reports it merges cleanly. With the
 * `auto_merge_queue` setting off, and for a pull request that changes a protected path, it also refuses
 * unless the item's record holds a maintainer's approval at exactly that head.
 *
 * A passing gate merges pinned to the head. A merge moves the default branch, so the
 * forge may not have computed the next pull request's merge yet: that read is repeated
 * a few times before the gate refuses it. A refusal, or a merge the forge cannot verify,
 * is reported per pull request and stops nothing else; the record node settles every
 * pull request against the forge and leaves a refused one for the next sweep.
 *
 * Bound inputs: INPUTS_ITEMS from facts; INPUTS_SWEEP, the sweep's whole output; the
 * workflow's INPUTS_MERGE_METHOD and the pack settings INPUTS_CI, INPUTS_AUTO_MERGE_QUEUE and
 * INPUTS_PROTECTED_PATHS.
 */

import { emit, input, refuse } from 'archon:script';
import { latestValidation } from '../../.shared/build.ts';
import type { QualifiedPr } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import {
  type CiTrust,
  boolSetting,
  gateRefusals,
  listSetting,
  MERGE_METHODS,
  type MergeMethod,
  mergeAtHead,
  parseCiMode,
  type PrFacts,
  protectedChanges,
  readBase,
  readPr,
} from '../../.shared/merge.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';
import { read, workItemName } from '../../.shared/workitem.ts';

interface Item {
  readonly item: QualifiedPr | null;
  readonly pr: QualifiedPr;
}

interface Gated {
  readonly number: number;
  readonly head: string;
  readonly refusals: string[];
  readonly merge_commit: string | null;
}

interface GateSettings {
  readonly method: MergeMethod;
  readonly ci: ReturnType<typeof parseCiMode>;
  readonly manual: boolean;
  readonly protectedPaths: readonly string[];
}

const UNKNOWN_READS = 4;
const UNKNOWN_PAUSE_MS = 5000;

/** The pull request's facts, read again while the forge has not computed whether it merges. */
function readComputed(pr: QualifiedPr, maintainers: ReadonlySet<string>): PrFacts {
  let facts = readPr(pr, maintainers);
  for (let reads = 1; reads < UNKNOWN_READS && facts.behind > 0 && facts.mergeable === 'unknown'; reads++) {
    Bun.sleepSync(UNKNOWN_PAUSE_MS);
    facts = readPr(pr, maintainers);
  }
  return facts;
}

/** Gate one pull request at `head` and merge it when nothing refuses. */
function gateAndMerge(item: Item, head: string, settings: GateSettings, maintainers: ReadonlySet<string>): Omit<Gated, 'number' | 'head'> {
  const doc = item.item === null ? undefined : read(workItemName(item.item.number))?.doc;
  const ci: CiTrust = settings.ci === 'forge' ? { mode: 'forge' } : { mode: 'none', validation: doc === undefined ? null : latestValidation(doc) };
  const refusals = gateRefusals(readComputed(item.pr, maintainers), head, readBase(item.pr.repo), ci, {
    manual: settings.manual,
    protected: protectedChanges(item.pr, settings.protectedPaths),
    approved: doc?.facts.merge?.approval?.head ?? null,
  });
  if (refusals.length > 0) return { refusals, merge_commit: null };
  return { refusals, merge_commit: mergeAtHead(item.pr, head, settings.method) };
}

function main(): void {
  const items = (nullableJson(input('items')) ?? []) as Item[];
  const sweep = nullableJson(input('sweep')) as NodeOutput<'archon-merge-queue', 'sweep'> | null;
  const method = MERGE_METHODS.find(candidate => candidate === input('merge_method').trim());
  if (method === undefined) throw new Error(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  const settings: GateSettings = {
    method,
    ci: parseCiMode(input('ci').trim()),
    manual: !boolSetting('auto_merge_queue'),
    protectedPaths: listSetting(input('protected_paths')),
  };
  const merges = (sweep?.decisions ?? []).filter(decision => decision.action === 'merge');
  const maintainers = merges.length > 0 && items[0] !== undefined ? readMaintainers(items[0].pr.repo) : new Set<string>();
  const gated: Gated[] = [];
  for (const { number, head } of merges) {
    // A decision for a pull request this run did not claim is the record node's to report.
    const item = items.find(candidate => candidate.pr.number === number);
    if (item === undefined || gated.some(done => done.number === number)) continue;
    try {
      gated.push({ number, head, ...gateAndMerge(item, head, settings, maintainers) });
    } catch (error) {
      const failure = `the gate or the merge did not complete: ${error instanceof Error ? error.message : String(error)}`;
      gated.push({ number, head, refusals: [failure], merge_commit: null });
    }
  }
  emit({ gated });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue merge: ${error instanceof Error ? error.message : String(error)}`);
}
