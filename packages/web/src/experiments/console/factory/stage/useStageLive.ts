import { useEffect, useMemo, useRef } from 'react';
import type { FactoryItem } from '../../skills/factory';
import type { AttentionQueueItem } from '../../skills/runs';
import { stageLive, type MapLive, type Unread } from '../lib/map-live';
import type { FactoryViewListed } from '../lib/views';
import { useMinuteClock } from '../useMinuteClock';

/**
 * Where each item sits, by stage, for the map's chips and the stages opened from it, or why
 * that is not known yet (`items` undefined). It keeps where each item sat on the last read, as
 * the board does, so a run on a step no stage names holds its card where the board holds its
 * column, and reads the minute clock as the board does, so an item the board sets aside as
 * idle leaves the map in the same minute. A page computes it once and hands the one value to everything that shows a stage's
 * items, so a card's "2 here" and the list under it never disagree.
 */
export function useStageLive(
  view: FactoryViewListed['declaration'],
  projectId: string,
  items: readonly FactoryItem[] | undefined,
  unread: Unread,
  queue: readonly AttentionQueueItem[] | undefined
): MapLive | Unread {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  const now = useMinuteClock();
  const live = useMemo(
    () =>
      items === undefined
        ? unread
        : stageLive(view, projectId, items, queue ?? [], previous.current, now),
    [view, projectId, items, queue, unread, now]
  );
  useEffect(() => {
    if (typeof live !== 'string') previous.current = live.positions;
  }, [live]);
  return live;
}
