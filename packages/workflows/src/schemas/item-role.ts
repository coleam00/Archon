/**
 * Whether work on an item is a step of it, the one owner of that fact. A workflow that declares
 * `observes: true` runs on an item without being one of its steps (`observesItem`); each of its
 * runs records so when it is created (`observesItemMetadata`), and every reader of stored work
 * reads that record (`observesItemRecorded`, and `stepRun` in the SQL stores). A start with no
 * run yet carries the role its prepared launch records, or none before preparation (`ItemStart`).
 */
import type { StartCause } from './resource-start';

/**
 * Set when a run of a workflow that declares `observes: true` is created: the run acts on
 * its item without being one of its steps, so the item's stop and end rules read past it
 * (see `itemFate`). Written once, in the creation write, so a pending run of a queued start
 * already carries it. Older binaries read metadata as an open record and ignore the key, so
 * they count the run as a step.
 */
export const OBSERVES_ITEM_METADATA_KEY = 'observes_item';

/**
 * Whether a workflow's runs observe their item instead of being steps of it: the one reading
 * of `observes: true`. The completion's fate, a run's creation metadata, a binding's target
 * and the pack graph's stages all ask it. A run that exists is asked through what it recorded
 * (`observesItemRecorded`, and `stepRun` in the SQL stores), which this writes.
 */
export function observesItem(workflow: { readonly observes?: boolean }): boolean {
  return workflow.observes === true;
}

/** The creation metadata that records a run as observing its item, or none for a step. */
export function observesItemMetadata(workflow: { readonly observes?: boolean }): {
  [OBSERVES_ITEM_METADATA_KEY]?: true;
} {
  return observesItem(workflow) ? { [OBSERVES_ITEM_METADATA_KEY]: true } : {};
}

/** Whether run metadata records the run as observing its item (`observesItemMetadata`). */
export function observesItemRecorded(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>)[OBSERVES_ITEM_METADATA_KEY] === true
  );
}

/**
 * A start on an item that has no run yet, with what caused it and what its run will be. The
 * role is the one recorded fact, `observes_item` in the run metadata preparation writes
 * (`observesItemMetadata`): a queued request's prepared launch carries it, so its run is a
 * `step` or an `observer`. An unprepared binding (waiting to be prepared, being prepared, or
 * retrying, under the install hold or not) has no record yet, so its role is `unprepared`;
 * nothing reads its target's definition to guess one. `cause` is null for a queued start no
 * receipt carries (a hand start) or whose receipt's source actor does not read.
 */
export type ItemStart =
  | {
      phase: 'queued';
      requestId: string;
      cause: StartCause | null;
      role: 'step' | 'observer';
    }
  | {
      phase: 'unprepared';
      receiptId: string;
      bindingId: string;
      cause: StartCause | null;
      role: 'unprepared';
    };
