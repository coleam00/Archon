/**
 * The reference of an attention queue item: how a surface names one item to answer it.
 */
import {
  readAttentionQueueItem,
  type AttentionQueueItem,
  type AttentionQueueSource,
} from './attention-queue';

const ITEM_REF_SEPARATOR = ':';

/**
 * The reference of a queue item: the one string a surface hands out with an item and
 * takes back to answer it. Callers treat it as opaque; only this module builds and reads
 * it. Today it names the item's run and, for an item that takes an answer, the occurrence
 * of its pause, so a reference to an earlier pause of the same run no longer matches.
 */
export function attentionItemRef(item: AttentionQueueItem): string {
  return 'occurrence' in item ? `${item.runId}${ITEM_REF_SEPARATOR}${item.occurrence}` : item.runId;
}

/**
 * What an item reference names now: the item it was built from (`found`), a different
 * item where that one was (`moved`: the pause it named is over and another is open), no
 * open item (`none`), or nothing this install knows (`unknown`).
 */
export type AttentionItemRefRead =
  | { kind: 'found'; item: AttentionQueueItem }
  | { kind: 'moved'; item: AttentionQueueItem }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** Read the item `ref` names, by the rule `attentionItemRef` builds it. */
export async function readAttentionQueueItemByRef(
  source: AttentionQueueSource,
  ref: string
): Promise<AttentionItemRefRead> {
  const [runId] = ref.split(ITEM_REF_SEPARATOR, 1);
  if (runId === undefined || runId === '') return { kind: 'unknown' };
  const item = await readAttentionQueueItem(source, runId);
  if (item === undefined) return { kind: 'unknown' };
  if (item === null) return { kind: 'none' };
  return attentionItemRef(item) === ref ? { kind: 'found', item } : { kind: 'moved', item };
}
