/**
 * An operator's act on an item outside any run: recording or withdrawing a ruling, recording
 * or ending a link. Each records who did it when they say, through which surface and when.
 */
import { z } from 'zod';
import { recordSurfaceSchema } from './record-surface';
import { attentionAnswererSchema, attentionAnsweringRunSchema } from './run-wait';

/** Who acted, through which surface and when. */
export const itemActFields = {
  at: z.string().datetime(),
  via: recordSurfaceSchema,
  /** Null when nobody said who they were. */
  by: attentionAnswererSchema.nullable(),
  /** The run and node the call came from, reported by its environment and not verified. */
  fromRun: attentionAnsweringRunSchema.nullable(),
};

/** Who acts on an item, as the surface resolved them; the store adds the time. */
export interface ItemAct {
  via: z.infer<typeof recordSurfaceSchema>;
  by: z.infer<typeof attentionAnswererSchema> | null;
  fromRun: z.infer<typeof attentionAnsweringRunSchema> | null;
}
