/**
 * Every item of a project and its work orders' own reads: the one read the Board's columns,
 * work orders, Merged column, Table and Set aside strip and the Overview's numbers all count
 * from. One cache key, so opening one page after the other reads once.
 */
import type { ItemRead } from '../skills/items';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { listOrderItems } from './lib/work-orders';

export function useBoardItems(projectId: string): {
  data: ItemRead[] | undefined;
  error: Error | undefined;
} {
  const { data, error } = useEntity<ItemRead[]>(K.boardOrders(projectId), () =>
    listOrderItems(projectId)
  );
  return { data, error };
}
