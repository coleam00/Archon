import { describe, expect, test } from 'bun:test';
import { ItemWindowQueryError, readItemWindow, type ItemWindowSource } from './item-window';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';

const PROJECT = 'acme/web';
const items: WorkflowItem[] = ['a', 'b', 'c'].map(key => ({
  id: `item-${key}`,
  projectKey: PROJECT,
  key,
}));

function run(id: string, itemId: string, workflow: string, startedAt: string): WorkflowRun {
  return {
    origin: null,
    id,
    workflow_name: workflow,
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'completed',
    outcome: null,
    completed_outcome: workflow === 'build' ? 'built' : 'approved',
    user_message: '',
    metadata: {},
    active_phase_started_at: null,
    started_at: new Date(startedAt),
    completed_at: new Date(startedAt),
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: itemId,
  };
}

// The window is November. Item a and c have runs in it; b only before it. Every item's
// runs are listed in start order, including the one before the window.
const runsByItem = new Map<string, WorkflowRun[]>([
  [
    'item-a',
    [
      run('a1', 'item-a', 'build', '2026-10-20T00:00:00.000Z'),
      run('a2', 'item-a', 'review', '2026-11-02T00:00:00.000Z'),
    ],
  ],
  ['item-b', [run('b1', 'item-b', 'build', '2026-10-05T00:00:00.000Z')]],
  [
    'item-c',
    [
      run('c1', 'item-c', 'build', '2026-11-03T00:00:00.000Z'),
      run('c2', 'item-c', 'review', '2026-12-02T00:00:00.000Z'),
    ],
  ],
]);

function source(
  unreadable: string[] = [],
  statuses: Record<string, WorkflowRun['status']> = {},
  queuedOn: string[] = [],
  mergedIds: string[] = []
): ItemWindowSource {
  return {
    branchOf: async () => null,
    store: {
      listItemsInWindow: async query =>
        items
          .filter(item => query.afterItemId === null || item.id > query.afterItemId)
          .filter(item =>
            (runsByItem.get(item.id) ?? []).some(
              row => row.started_at >= query.since && row.started_at < query.until
            )
          )
          .slice(0, query.limit),
      getItemRuns: async (_project, key) => {
        const item = items.find(entry => entry.key === key);
        if (!item) return null;
        const runs = (runsByItem.get(item.id) ?? [])
          .map(row => (statuses[row.id] === undefined ? row : { ...row, status: statuses[row.id] }))
          .map(row =>
            unreadable.includes(row.id)
              ? ({ type: 'degraded', reason: 'run_unreadable', runId: row.id } as const)
              : row
          );
        return { item, runs, descendantIds: [] };
      },
      listEventsForRuns: async () => new Map(),
      listAttentionQueueRows: async () => [],
      getWorkflowRun: async () => null,
      getWorkflowRunForAttention: async () => null,
      getCodebase: async () => null,
      getItem: async () => null,
      listItemRulings: async () => [],
      getItemMerge: async itemId =>
        mergedIds.includes(itemId)
          ? { type: 'degraded', reason: 'merge_unreadable', itemId }
          : null,
      getItemLanding: async () => null,
      listItemLinks: async () => [],
      listItemAsks: async () => [],
      listOpenItemWaits: async () => [],
      listQueuedItemStarts: async itemId =>
        queuedOn.includes(itemId)
          ? [
              {
                requestId: `start-${itemId}`,
                workflow: 'review',
                resource: 'review',
                hostId: 'host',
                queuedAt: '2026-11-04T00:00:00.000Z',
                ahead: 0,
              },
            ]
          : [],
      listSkippedItemStarts: async () => [],
      readItemStartLimits: async () => ({ limits: [], countedUnder: {} }),
      getInstallHold: async () => null,
      getRunLimit: async () => null,
      listHeldItemStarts: async () => [],
      getResourceStartRequest: async () => null,
      getStartReceipt: async () => null,
    },
  };
}

const NOVEMBER = { since: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' };

describe('reading items over a window', () => {
  test('returns exactly the items with a run in the window, each with all its runs in start order', async () => {
    const page = await readItemWindow(source(), PROJECT, NOVEMBER);
    expect(page.window).toEqual({
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-12-01T00:00:00.000Z',
    });
    expect(
      page.items.map(read => [
        read.item.key,
        read.runs.map(row => [row.id, row.workflow, row.outcome]),
      ])
    ).toEqual([
      [
        'a',
        [
          ['a1', 'build', 'built'],
          ['a2', 'review', 'approved'],
        ],
      ],
      [
        'c',
        [
          ['c1', 'build', 'built'],
          ['c2', 'review', 'approved'],
        ],
      ],
    ]);
    expect(page.next).toBeNull();
  });

  test('a page past the limit returns a cursor, and following it returns the rest once', async () => {
    const wide = { since: '2026-10-01T00:00:00Z', until: '2027-01-01T00:00:00Z' };
    const keys: string[] = [];
    let page = await readItemWindow(source(), PROJECT, { ...wide, limit: 1 });
    keys.push(...page.items.map(read => read.item.key));
    let pages = 1;
    while (page.next !== null) {
      page = await readItemWindow(source(), PROJECT, { after: page.next, limit: 1 });
      keys.push(...page.items.map(read => read.item.key));
      pages += 1;
    }
    expect(keys).toEqual(['a', 'b', 'c']);
    expect(pages).toBe(3);
  });

  test('each item says where it stands, and open keeps the ones something still moves', async () => {
    const wide = { since: '2026-10-01T00:00:00Z', until: '2027-01-01T00:00:00Z' };
    // a: its first run still runs after a later one ended. b: its only run failed.
    // c: every run ended, and a start waits for admission.
    const moving = (): ItemWindowSource => source([], { a1: 'running', b1: 'failed' }, ['item-c']);
    const all = await readItemWindow(moving(), PROJECT, wide);
    expect(all.items.map(read => [read.item.key, read.standing])).toEqual([
      ['a', { runId: 'a1', state: 'running' }],
      ['b', { runId: 'b1', state: 'failed' }],
      ['c', { runId: 'c2', state: 'queued' }],
    ]);
    // Nothing moves an item whose runs all ended: it rests at its latest run.
    const rested = await readItemWindow(source([], { b1: 'failed' }), PROJECT, wide);
    expect(rested.items.map(read => [read.item.key, read.standing])).toEqual([
      ['a', { runId: 'a2', state: 'resting' }],
      ['b', { runId: 'b1', state: 'failed' }],
      ['c', { runId: 'c2', state: 'resting' }],
    ]);

    // A recorded merge rests the item, whatever its last run did.
    const merged = await readItemWindow(
      source([], { b1: 'failed' }, [], ['item-b']),
      PROJECT,
      wide
    );
    expect(merged.items.map(read => read.standing.state)).toEqual([
      'resting',
      'resting',
      'resting',
    ]);

    // The filter holds across pages: a page fills with matching items only.
    const keys = async (open: boolean): Promise<string[]> => {
      const found: string[] = [];
      let page = await readItemWindow(source([], { b1: 'failed' }), PROJECT, {
        ...wide,
        open,
        limit: 1,
      });
      for (;;) {
        found.push(...page.items.map(read => read.item.key));
        if (page.next === null) return found;
        page = await readItemWindow(source([], { b1: 'failed' }), PROJECT, {
          after: page.next,
          open,
          limit: 1,
        });
      }
    };
    expect(await keys(true)).toEqual(['b']);
    // Most recently active first: c's last run ended after a's.
    expect(await keys(false)).toEqual(['c', 'a']);
    // The totals count the whole window, whatever the page holds.
    const first = await readItemWindow(source([], { b1: 'failed' }), PROJECT, {
      ...wide,
      open: false,
      limit: 1,
    });
    expect(first.totals).toEqual({ open: 1, resting: 2 });
    // No run here recorded a pack, so no item is a pack's.
    const ofPack = await readItemWindow(source(), PROJECT, { ...wide, pack: 'flow' });
    expect([ofPack.items, ofPack.totals]).toEqual([[], { open: 0, resting: 0 }]);
  });

  test('an item whose runs cannot all be read is reported as degraded, and the rest of it reads', async () => {
    const page = await readItemWindow(source(['a1']), PROJECT, NOVEMBER);
    const a = page.items.find(read => read.item.key === 'a');
    expect(a?.runs.map(row => row.id)).toEqual(['a2']);
    expect(a?.degraded).toEqual([{ type: 'degraded', reason: 'run_unreadable', runId: 'a1' }]);
  });

  test('a cursor for another project, or a window beside a cursor, is refused', async () => {
    const first = await readItemWindow(source(), PROJECT, { ...NOVEMBER, limit: 1 });
    const next = first.next ?? '';
    expect(next).not.toBe('');
    await expect(readItemWindow(source(), 'other/repo', { after: next })).rejects.toThrow(
      ItemWindowQueryError
    );
    await expect(readItemWindow(source(), PROJECT, { after: next, since: '7d' })).rejects.toThrow(
      ItemWindowQueryError
    );
    await expect(readItemWindow(source(), PROJECT, { after: 'not-a-cursor' })).rejects.toThrow(
      ItemWindowQueryError
    );
  });
});
