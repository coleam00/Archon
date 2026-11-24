import { useEffect, useMemo } from 'react';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import {
  FACTORY_ITEMS_READS,
  readEveryFactoryItem,
  type FactoryItemsRead,
} from './lib/factory-items-read';
import { anyMergePending, awaitingMerge } from './lib/merge-pending';
import { scheduleReread } from './merge-reread';
import { watchMerges } from './merge-watch';
import { useFactoryRead } from './useFactoryRead';
import type { FactoryItem } from '../skills/factory';

/**
 * Every item of the project with its progress, and the members of every work order they
 * name, for every Factory page. The dashboard SSE invalidates `factory-items` when a run
 * starts, changes step or ends, and the attention stream when an ask opens or closes. While
 * any item's merge state is `pending` it reads again shortly, a failed read included, until
 * the server has the answer. While any item's change is not merged it asks about those items
 * on an interval (`watchMerges`), because a merge on the forge is no run event.
 */
export function useFactoryItemsRead(projectId: string): EntityView<FactoryItemsRead> {
  const read = useFactoryRead(K.factoryItems(projectId), within =>
    readEveryFactoryItem(projectId, FACTORY_ITEMS_READS, within)
  );
  const { data, error } = read;
  // `error` is a dependency on purpose: a failed re-read keeps the same `data`, and must
  // still schedule the next one.
  useEffect(() => {
    if (data !== undefined && anyMergePending(data.items))
      scheduleReread(K.factoryItems(projectId));
  }, [data, error, projectId]);
  // Keyed on the boolean, not `data`: a refresh that still waits keeps the watch's clock.
  const waiting = data !== undefined && data.items.some(awaitingMerge);
  useEffect(() => (waiting ? watchMerges(projectId) : undefined), [waiting, projectId]);
  return read;
}

/** The items of `useFactoryItemsRead`, for the pages that read no work order. */
export function useFactoryItems(projectId: string): EntityView<FactoryItem[]> {
  const read = useFactoryItemsRead(projectId);
  const items = useMemo(() => read.data?.items, [read.data]);
  return { ...read, data: items };
}
