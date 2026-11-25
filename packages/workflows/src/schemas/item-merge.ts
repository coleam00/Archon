/**
 * The merge of an item's change: the one fact about an item that comes from outside the
 * engine. The caller that read the forge's report records it (`archon workflow merged`);
 * the engine stores it once and never decides which change belongs to which item.
 */
import { z } from 'zod';
import { recordSurfaceSchema } from './record-surface';
import { attentionAnsweringRunSchema } from './run-wait';

/** The forge's identity of the merged change, such as a pull request URL. Never parsed. */
export const itemMergeChangeSchema = z.string().min(1).max(2048);
export const itemMergeCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
/** The merge time a caller reports: ISO, with an offset so it names one instant. */
export const itemMergeAtSchema = z.iso.datetime({ offset: true });

export const itemMergeSchema = z.object({
  change: itemMergeChangeSchema,
  /** The merge commit, when the forge reported one. */
  commit: itemMergeCommitSchema.nullable(),
  /** When the forge says the change merged. */
  at: z.string().datetime(),
  /** When the engine recorded the fact. */
  recordedAt: z.string().datetime(),
  via: recordSurfaceSchema,
  /** The run and node the call came from, reported by its environment and not verified. */
  fromRun: attentionAnsweringRunSchema.nullable(),
});
export type ItemMerge = z.infer<typeof itemMergeSchema>;

/** A merge row the store could not read; the rest of the item still reads. */
export const itemMergeDegradedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('merge_unreadable'),
  itemId: z.string(),
});
export type ItemMergeDegraded = z.infer<typeof itemMergeDegradedSchema>;

export interface ItemMergeReport {
  projectKey: string;
  key: string;
  change: string;
  commit: string | null;
  /** ISO time with an offset; stored in UTC. */
  at: string;
  via: z.infer<typeof recordSurfaceSchema>;
  fromRun: z.infer<typeof attentionAnsweringRunSchema> | null;
}

/** `recorded` is false when the item already carried a merge; `merge` is then the first. */
export const itemMergeRecordedSchema = z.object({ merge: itemMergeSchema, recorded: z.boolean() });
export type ItemMergeRecorded = z.infer<typeof itemMergeRecordedSchema>;
