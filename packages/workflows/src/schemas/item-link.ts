/**
 * A link: an accepted, directed relation from one item to another. The engine stores and
 * reports links; it ranks, holds or starts nothing because of one by itself. A run-ended
 * trigger file can name a kind and start a stage across it (`on.runEnded.linked`), and an
 * active `part_of` carries the landing branch of the item it points at
 * (`resolveItemLanding`). A link that stops being true is ended, and the record stays and
 * says so.
 */
import { z } from 'zod';
import { itemActFields } from './item-act';
import { workflowItemSchema } from './workflow-run';

/**
 * The kinds a link can be, each read from `from` to `to`: `from` waits for `to`
 * (`depends_on`), is a piece of `to` (`part_of`), or goes away in favour of `to`
 * (`duplicate_of`). This is the only place the kinds are checked: the database stores any
 * kind, so a later kind is a code change, and a reader meets a kind it does not know as an
 * unreadable link.
 */
export const itemLinkKindSchema = z.enum(['depends_on', 'part_of', 'duplicate_of']);
export type ItemLinkKind = z.infer<typeof itemLinkKindSchema>;

export const itemLinkSchema = z.object({
  id: z.string().min(1),
  kind: itemLinkKindSchema,
  from: workflowItemSchema,
  to: workflowItemSchema,
  /** Who recorded the link and when. */
  ...itemActFields,
  /** Null while the link is active. */
  ended: z.object(itemActFields).nullable(),
});
export type ItemLink = z.infer<typeof itemLinkSchema>;

/** A link row the store could not read; the rest of the item still reads. */
export const itemLinkDegradedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('link_unreadable'),
  linkId: z.string(),
});
export type ItemLinkDegraded = z.infer<typeof itemLinkDegradedSchema>;

export type ItemLinkRead = ItemLink | ItemLinkDegraded;

/** A link joins two different items. */
export class ItemLinkSelfError extends Error {
  constructor(readonly key: string) {
    super(`An item cannot link to itself: '${key}'.`);
    this.name = 'ItemLinkSelfError';
  }
}

export class ItemLinkNotFoundError extends Error {
  constructor(readonly linkId: string) {
    super(`No link '${linkId}'.`);
    this.name = 'ItemLinkNotFoundError';
  }
}

/** The link starts at an item outside the project the end was scoped to. */
export class ItemLinkOutsideProjectError extends Error {
  constructor(
    readonly linkId: string,
    readonly projectKey: string
  ) {
    super(`Link '${linkId}' is from an item outside project ${projectKey}; it was not ended.`);
    this.name = 'ItemLinkOutsideProjectError';
  }
}

/** The link was already ended; a link ends once. */
export class ItemLinkEndedError extends Error {
  constructor(readonly linkId: string) {
    super(`Link '${linkId}' was already ended.`);
    this.name = 'ItemLinkEndedError';
  }
}
