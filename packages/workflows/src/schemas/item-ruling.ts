/**
 * A ruling: a decision an operator recorded about an item without a question having been
 * asked. It is a fact about the item, like an answer, and it can be withdrawn; the record
 * stays and says so. The engine stores the text and never reads it.
 */
import { z } from 'zod';
import { itemActFields } from './item-act';

export const itemRulingSchema = z.object({
  kind: z.literal('ruling'),
  id: z.string().min(1),
  text: z.string().min(1),
  ...itemActFields,
  /** Null while the ruling stands. */
  withdrawn: z.object(itemActFields).nullable(),
});
export type ItemRuling = z.infer<typeof itemRulingSchema>;

/** A ruling row the store could not read; the rest of the item still reads. */
export const itemRulingDegradedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('ruling_unreadable'),
  rulingId: z.string(),
});
export type ItemRulingDegraded = z.infer<typeof itemRulingDegradedSchema>;

export type ItemRulingRead = ItemRuling | ItemRulingDegraded;

/** No ruling has this id; a withdrawal's own row is not a ruling either. */
export class ItemRulingNotFoundError extends Error {
  constructor(readonly rulingId: string) {
    super(`No ruling '${rulingId}'.`);
    this.name = 'ItemRulingNotFoundError';
  }
}

/** The ruling belongs to an item outside the project the withdrawal was scoped to. */
export class ItemRulingOutsideProjectError extends Error {
  constructor(
    readonly rulingId: string,
    readonly projectKey: string
  ) {
    super(
      `Ruling '${rulingId}' is on an item outside project ${projectKey}; it was not withdrawn.`
    );
    this.name = 'ItemRulingOutsideProjectError';
  }
}

/** The ruling was already withdrawn; a withdrawal happens once. */
export class ItemRulingWithdrawnError extends Error {
  constructor(readonly rulingId: string) {
    super(`Ruling '${rulingId}' was already withdrawn.`);
    this.name = 'ItemRulingWithdrawnError';
  }
}
