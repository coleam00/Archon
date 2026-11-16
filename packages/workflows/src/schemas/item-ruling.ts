/**
 * A ruling: a decision an operator recorded about an item without a question having been
 * asked. It is a fact about the item, like an answer, and it can be withdrawn; the record
 * stays and says so. The engine stores the text and never reads it.
 */
import { z } from 'zod';
import { recordSurfaceSchema } from './record-surface';
import { attentionAnswererSchema, attentionAnsweringRunSchema } from './run-wait';

/** Who recorded or withdrew a ruling, through which surface and when. */
const rulingActFields = {
  at: z.string().datetime(),
  via: recordSurfaceSchema,
  /** Null when nobody said who they were. */
  by: attentionAnswererSchema.nullable(),
  /** The run and node the call came from, reported by its environment and not verified. */
  fromRun: attentionAnsweringRunSchema.nullable(),
};

export const itemRulingSchema = z.object({
  kind: z.literal('ruling'),
  id: z.string().min(1),
  text: z.string().min(1),
  ...rulingActFields,
  /** Null while the ruling stands. */
  withdrawn: z.object(rulingActFields).nullable(),
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

/** Who records or withdraws a ruling, as the surface resolved them. */
export interface ItemRulingAct {
  via: z.infer<typeof recordSurfaceSchema>;
  by: z.infer<typeof attentionAnswererSchema> | null;
  fromRun: z.infer<typeof attentionAnsweringRunSchema> | null;
}

/** No ruling has this id; a withdrawal's own row is not a ruling either. */
export class ItemRulingNotFoundError extends Error {
  constructor(readonly rulingId: string) {
    super(`No ruling '${rulingId}'.`);
    this.name = 'ItemRulingNotFoundError';
  }
}

/** The ruling was already withdrawn; a withdrawal happens once. */
export class ItemRulingWithdrawnError extends Error {
  constructor(readonly rulingId: string) {
    super(`Ruling '${rulingId}' was already withdrawn.`);
    this.name = 'ItemRulingWithdrawnError';
  }
}
