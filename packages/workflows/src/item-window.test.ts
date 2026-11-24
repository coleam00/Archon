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

function source(unreadable: string[] = []): ItemWindowSource {
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
        const runs = (runsByItem.get(item.id) ?? []).map(row =>
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
      getItemMerge: async () => null,
      getItemLanding: async () => null,
      listItemLinks: async () => [],
      listItemAsks: async () => [],
      listOpenItemWaits: async () => [],
      listQueuedItemStarts: async () => [],
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
