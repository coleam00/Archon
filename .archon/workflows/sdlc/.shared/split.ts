/**
 * The split queue's record on an item's work item: `facts.split`.
 *
 * Triage routes a PRD or a bundle of tasks to `split`; archon-split files the issues
 * it splits into. The record lists every issue filed from the item by its key, written
 * as each one is filed, so a run that stops part way, or a split repeated after a
 * re-triage, finds them and files none of them again.
 */

import type { Pickup, WorkItem } from './workitem.ts';

/** What the slice agent judged the item to be; archon-split.yaml declares the same enum. */
export const SPLIT_KINDS = ['prd', 'bundle'] as const;
export type SplitKind = (typeof SPLIT_KINDS)[number];

export interface SplitIssue {
  readonly key: string;
  readonly number: number;
  readonly url: string;
}

/**
 * `filing` while publish files the issues; `done` once every one is filed and a PRD is
 * labelled `archon-prd` or a bundle closed; `closed` when the item's issue was closed
 * before a split finished, so nothing more is filed for it.
 */
export type SplitRecord =
  | {
      readonly status: 'filing' | 'done';
      readonly kind: SplitKind;
      readonly issues: readonly SplitIssue[];
      /** A PRD's measurement: the command that prints its signal; null on a bundle. */
      readonly signal_command: string | null;
      /** How many days after release the PRD's threshold is judged; null on a bundle. */
      readonly window_days: number | null;
      readonly at: string;
      readonly run_id: string;
    }
  | {
      readonly status: 'closed';
      readonly issues: readonly SplitIssue[];
      readonly at: string;
      readonly run_id: string;
    };

/**
 * Whether an unclaimed item waits for the split queue: its stage is `split` and no
 * split finished on it, or a re-triage came after the last one.
 */
export function splitWaits(doc: WorkItem): boolean {
  if (doc.stage !== 'split') return false;
  const split = doc.facts.split;
  if (split === undefined || split.status === 'filing') return true;
  return (doc.facts.triage?.at ?? '') > split.at;
}

export const SPLIT_PICKUP: Pickup = { stage: 'split', waits: splitWaits, takesRequests: false };

/** The hidden first line of an issue filed from the item, which finds it again on a rerun. */
export function splitMarker(item: number, key: string): string {
  return `<!-- archon-split: ${String(item)} ${key} -->`;
}
