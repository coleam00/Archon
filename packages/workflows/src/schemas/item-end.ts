/**
 * An end: an operator's statement that nothing more will happen on an item. It is a fact
 * about the item, like a ruling, and nothing records one by itself. It holds until work
 * starts on the item again: a run on it starts or resumes at or after the end, or a start
 * waits on it. Opening the item writes nothing, and deleting old runs does not undo an end.
 * While it holds, the item is at rest and its stop is not in the attention queue.
 */
import { z } from 'zod';
import { itemActFields } from './item-act';
import { workflowRunStatusSchema } from './run-status';

export const itemEndSchema = z.object({
  kind: z.literal('ended'),
  id: z.string().min(1),
  reason: z.string().min(1),
  ...itemActFields,
  /** The item's latest run when it was ended; null for an item that had no run. */
  runId: z.string().nullable(),
});
export type ItemEnd = z.infer<typeof itemEndSchema>;

/** An end row the store could not read; the rest of the item still reads. */
export const itemEndDegradedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('end_unreadable'),
  endId: z.string(),
});
export type ItemEndDegraded = z.infer<typeof itemEndDegradedSchema>;

/**
 * What keeps an item from being ended: work on it that is still active or waiting. `run`
 * is one of the item's runs or a run below one of them.
 */
export const itemEndBlockerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    runId: z.string(),
    status: workflowRunStatusSchema,
  }),
  z.object({ kind: z.literal('queued_start'), requestId: z.string() }),
  z.object({ kind: z.literal('held_start'), receiptId: z.string() }),
  z.object({ kind: z.literal('open_ask'), ref: z.string() }),
  z.object({ kind: z.literal('open_wait'), runId: z.string() }),
]);
export type ItemEndBlocker = z.infer<typeof itemEndBlockerSchema>;

function blockerText(key: string, blocker: ItemEndBlocker): string {
  switch (blocker.kind) {
    case 'run':
      return `Run ${blocker.runId} on item ${key} is ${blocker.status}; let it end, or cancel or abandon it first.`;
    case 'queued_start':
      return `Start ${blocker.requestId} on item ${key} is queued; \`archon trigger withdraw ${blocker.requestId}\` withdraws it.`;
    case 'held_start':
      return `Trigger start ${blocker.receiptId} on item ${key} is held and not yet prepared.`;
    case 'open_ask':
      return `Ask ${blocker.ref} on item ${key} is open; answer or withdraw it in \`archon workflow attention\`.`;
    case 'open_wait':
      return `Run ${blocker.runId} left an open wait on item ${key}; withdraw it in \`archon workflow attention\`.`;
  }
}

/** The item has work that is still active or waiting; an item is ended only when it has none. */
export class ItemEndRefusedError extends Error {
  constructor(
    readonly key: string,
    readonly blocker: ItemEndBlocker
  ) {
    super(`${blockerText(key, blocker)} An item is ended only while nothing on it is active.`);
    this.name = 'ItemEndRefusedError';
  }
}

/** No item has the key in the project; ending never creates one. */
export class ItemEndNotFoundError extends Error {
  constructor(
    readonly projectKey: string,
    readonly key: string
  ) {
    super(`Project ${projectKey} has no item '${key}'.`);
    this.name = 'ItemEndNotFoundError';
  }
}

/** Nobody said who ends the item; an end records who said it. */
export class ItemEndUnattributedError extends Error {
  constructor() {
    super('Say who ends the item: pass --as <name> on the CLI, or `as` in an operator request.');
    this.name = 'ItemEndUnattributedError';
  }
}
