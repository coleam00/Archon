import type { Lifecycle, SymphonyCard } from './types';

export type GroupKey = 'lifecycle' | 'status' | 'repository';

const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  running: 'Running',
  retrying: 'Retrying',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export interface GroupOption {
  value: GroupKey;
  label: string;
  getKey: (card: SymphonyCard) => string;
  getLabel: (key: string) => string;
  /** Preferred ordering; columns not in this list go to the end alphabetically. */
  order?: string[];
}

/**
 * Best-effort repository label. Phase 3 doesn't expose explicit repository
 * data through `/api/symphony/state`, so we parse it back out of the
 * `dispatch_key`. For Linear there's no repo encoded in the key — fall back
 * to `workflow_name` (often a per-repo workflow) and finally `(linear)`.
 */
export function repositoryLabel(card: SymphonyCard): string {
  if (card.tracker === 'github') {
    const m = /^github:([^#]+)#/.exec(card.dispatch_key);
    if (m?.[1]) return m[1];
    return '(github)';
  }
  return card.workflow_name ?? '(linear)';
}

const groupOptionByKey: Record<GroupKey, GroupOption> = {
  lifecycle: {
    value: 'lifecycle',
    label: 'Lifecycle',
    getKey: c => c.lifecycle,
    getLabel: k => LIFECYCLE_LABEL[k as Lifecycle] ?? k,
    order: ['running', 'retrying', 'failed', 'completed', 'cancelled'],
  },
  status: {
    value: 'status',
    label: 'Tracker state',
    getKey: c => c.status ?? 'Unknown',
    getLabel: k => k,
    order: ['Todo', 'In Progress', 'Done', 'Cancelled'],
  },
  repository: {
    value: 'repository',
    label: 'Repository',
    getKey: c => repositoryLabel(c),
    getLabel: k => k,
  },
};

export const groupOptions: GroupOption[] = [
  groupOptionByKey.lifecycle,
  groupOptionByKey.status,
  groupOptionByKey.repository,
];

export interface GroupedCards {
  key: string;
  label: string;
  cards: SymphonyCard[];
}

export function groupCards(cards: SymphonyCard[], by: GroupKey): GroupedCards[] {
  const opt = groupOptionByKey[by];
  const buckets = new Map<string, SymphonyCard[]>();
  for (const c of cards) {
    const k = opt.getKey(c);
    const arr = buckets.get(k) ?? [];
    arr.push(c);
    buckets.set(k, arr);
  }
  const orderIndex = new Map<string, number>();
  if (opt.order) opt.order.forEach((k, i) => orderIndex.set(k, i));
  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = orderIndex.get(a);
    const ib = orderIndex.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.localeCompare(b);
  });
  return keys.map(k => ({
    key: k,
    label: opt.getLabel(k),
    cards: buckets.get(k) ?? [],
  }));
}

export { LIFECYCLE_LABEL };
