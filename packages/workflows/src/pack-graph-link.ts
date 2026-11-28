/**
 * The link a pack graph arrow starts its stage over, and how a binding gives it. Re-exported
 * by `pack-graph.ts`, whose arrows carry it.
 */
import { z } from 'zod';
import { readsLinkedEntry } from './schemas/binding-input-source';
import { runEndedLinkedSchema, type RunEndedLinked } from './schemas/resource-start';

/**
 * The link an arrow starts its stage over: `on.runEnded.linked`, with the result list
 * naming the items when it has `items`, and `entries`, each input of the started stage
 * that reads the started item's own entry of that list, by its entry pointer.
 */
export const arrowLinkSchema = z.object({
  ...runEndedLinkedSchema.shape,
  entries: z.record(z.string(), z.string()),
});
export type PackGraphLink = z.infer<typeof arrowLinkSchema>;

/** The arrow's link from a binding's `linked` and its inputs, or null without `linked`. */
export function graphLink(
  linked: RunEndedLinked | undefined,
  inputs: Readonly<Record<string, unknown>> | undefined
): PackGraphLink | null {
  if (linked === undefined) return null;
  const entries: Record<string, string> = {};
  for (const [target, source] of Object.entries(inputs ?? {}))
    if (typeof source === 'object' && source !== null && readsLinkedEntry(source))
      entries[target] = source.entry;
  return { ...linked, entries };
}
