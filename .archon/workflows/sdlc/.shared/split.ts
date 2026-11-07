/**
 * The split queue's record on an item's work item: `facts.split`.
 *
 * Triage routes a large item to `split` when building it as one work item would not
 * work; archon-split files the issues for its current phase, or hands it back to the
 * build queue whole when its agent finds one work item would work after all. The
 * record lists every issue filed from the item by its key, written as each one is
 * filed, so a run that stops part way, or the next phase's split after a re-triage,
 * finds them and files none of them again. It also lists the open issues
 * the split adopted instead of filing, because they already own part of the outcome:
 * the item's outcome waits on those as much as on the filed ones.
 */

import type { Pickup, WorkItem } from './workitem.ts';

/** What the slice agent judged the item to be; a test proves archon-split.yaml's enum agrees. */
export const SPLIT_KINDS = ['prd', 'epic', 'bundle'] as const;
export type SplitKind = (typeof SPLIT_KINDS)[number];

export interface SplitIssue {
  readonly key: string;
  readonly number: number;
  readonly url: string;
  /** The title it was filed with, so a later split's comment still names it. */
  readonly title: string;
}

/** An existing issue the item's outcome depends on, which the split did not file. */
export interface AdoptedIssue {
  readonly number: number;
  readonly url: string;
  /** Why the outcome depends on it, as the slice agent judged. */
  readonly why: string;
}

/** The build routes a split agent can hand an item back to, built as one work item. */
export type WholeRoute = 'plan' | 'deliver';

/**
 * `filing` while publish files the issues; `done` once every one is filed and a PRD is
 * labelled `archon-prd` or a bundle closed; `whole` when the agent judged the item one
 * work item and the queue handed it to the build queue at `route`, its reason in the
 * history entry; `closed` when the item's issue was closed before a split finished, so
 * nothing more is filed for it. A `whole` record files nothing, and publish refuses
 * `whole` once anything was filed.
 */
export type SplitRecord =
  | {
      readonly status: 'filing' | 'done';
      readonly kind: SplitKind;
      readonly issues: readonly SplitIssue[];
      readonly adopted: readonly AdoptedIssue[];
      readonly at: string;
      readonly run_id: string;
    }
  | {
      readonly status: 'whole';
      readonly route: WholeRoute;
      readonly at: string;
      readonly run_id: string;
    }
  | {
      readonly status: 'closed';
      readonly issues: readonly SplitIssue[];
      readonly at: string;
      readonly run_id: string;
    };

/** Every issue filed from the item so far. */
export function filedIssues(split: SplitRecord | undefined): readonly SplitIssue[] {
  return split === undefined || split.status === 'whole' ? [] : split.issues;
}

/** The open issues earlier splits adopted instead of filing. */
export function adoptedIssues(split: SplitRecord | undefined): readonly AdoptedIssue[] {
  return split?.status === 'filing' || split?.status === 'done' ? split.adopted : [];
}

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
