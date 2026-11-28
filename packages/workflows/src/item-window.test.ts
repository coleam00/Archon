import { describe, expect, test } from 'bun:test';
import { ItemWindowQueryError, readItemWindow, type ItemWindowSource } from './item-window';
import type { ItemLink } from './schemas/item-link';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';

const PROJECT = 'acme/web';
const defaultItems: WorkflowItem[] = ['a', 'b', 'c'].map(key => ({
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
const defaultRuns = new Map<string, WorkflowRun[]>([
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

interface World {
  unreadable?: string[];
  statuses?: Record<string, WorkflowRun['status']>;
  queuedOn?: string[];
  mergedIds?: string[];
  /** Item ids the engine recorded a stop for: the attention queue's `stopped` item. */
  stoppedOn?: string[];
  /** Metadata by run id, in place of the run's own. */
  metadata?: Record<string, Record<string, unknown>>;
  /** Items and runs in place of the module's. */
  items?: WorkflowItem[];
  runsByItem?: Map<string, WorkflowRun[]>;
  links?: ItemLink[];
}

function source(world: World = {}): ItemWindowSource {
  const {
    unreadable = [],
    statuses = {},
    queuedOn = [],
    mergedIds = [],
    stoppedOn = [],
    metadata = {},
    items = defaultItems,
    runsByItem = defaultRuns,
    links = [],
  } = world;
  return {
    branchOf: async () => null,
    itemsWithoutRun: async () =>
      items
        .filter(item => stoppedOn.includes(item.id))
        .map(item => {
          const last = (runsByItem.get(item.id) ?? []).at(-1);
          return {
            kind: 'stopped' as const,
            ref: `stopped-${item.id}`,
            project: null,
            item,
            priority: false,
            revision: 1,
            labels: {},
            pausedAt: null,
            stoppedIn: {
              runId: last?.id ?? 'none',
              workflow: last?.workflow_name ?? 'none',
              outcome: last?.completed_outcome ?? null,
            },
            summary: null,
            checkout: null,
          };
        }),
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
          .map(row => ({
            ...row,
            status: statuses[row.id] ?? row.status,
            metadata: metadata[row.id] ?? row.metadata,
          }))
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
      getItemPriority: async () => null,
      getHoldingItemEnd: async () => null,
      listItemLinks: async itemId =>
        links.filter(link => link.from.id === itemId || link.to.id === itemId),
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
                blockedBy: null,
              },
            ]
          : [],
      listSkippedItemStarts: async () => [],
      readItemStartLimits: async () => ({ limits: [], countedUnder: {} }),
      getInstallHold: async () => null,
      getRunLimit: async () => null,
      listHeldItemStarts: async () => [],
      listAllHeldItemStarts: async () => [],
      listItemStarts: async () => [],
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

  test('each item says where it stands, and states keeps the ones asked for', async () => {
    const wide = { since: '2026-10-01T00:00:00Z', until: '2027-01-01T00:00:00Z' };
    // a: its first run still runs after a later one ended. b: its only run failed.
    // c: every run ended, and a start waits for admission.
    const moving = (): ItemWindowSource =>
      source({ statuses: { a1: 'running', b1: 'failed' }, queuedOn: ['item-c'] });
    const all = await readItemWindow(moving(), PROJECT, wide);
    expect(all.items.map(read => [read.item.key, read.standing])).toEqual([
      ['a', { runId: 'a1', state: 'running', pack: null }],
      ['b', { runId: 'b1', state: 'failed', pack: null }],
      ['c', { runId: 'c2', state: 'queued', pack: null }],
    ]);
    // An item the engine recorded a stop for is stopped, not done. Done is a recorded merge,
    // whatever the last run did.
    const ended = (): ItemWindowSource =>
      source({
        statuses: { b1: 'failed' },
        mergedIds: ['item-b', 'item-c'],
        stoppedOn: ['item-a'],
      });
    const rested = await readItemWindow(ended(), PROJECT, wide);
    expect(rested.items.map(read => [read.item.key, read.standing])).toEqual([
      ['a', { runId: 'a2', state: 'stopped', pack: null }],
      ['b', { runId: 'b1', state: 'done', pack: null }],
      ['c', { runId: 'c2', state: 'done', pack: null }],
    ]);

    // The filter holds across pages, most recently active first: c's last run ended after b's.
    const keys = async (states: ('done' | 'stopped')[]): Promise<string[]> => {
      const found: string[] = [];
      let page = await readItemWindow(ended(), PROJECT, { ...wide, states, limit: 1 });
      for (;;) {
        found.push(...page.items.map(read => read.item.key));
        if (page.next === null) return found;
        page = await readItemWindow(ended(), PROJECT, { after: page.next, states, limit: 1 });
      }
    };
    expect(await keys(['stopped'])).toEqual(['a']);
    expect(await keys(['done'])).toEqual(['c', 'b']);
    // The totals count the whole window, whatever the page holds.
    const first = await readItemWindow(ended(), PROJECT, { ...wide, states: ['done'], limit: 1 });
    expect(first.totals).toMatchObject({ done: 2, stopped: 1, running: 0 });
    // No run here recorded a pack, so no item is a pack's.
    const ofPack = await readItemWindow(source(), PROJECT, { ...wide, pack: 'flow' });
    expect([ofPack.items, ofPack.totals?.done]).toEqual([[], 0]);
  });

  test('the pack filter keeps an item whose standing run recorded the pack key alone', async () => {
    const wide = { since: '2026-10-01T00:00:00Z', until: '2027-01-01T00:00:00Z' };
    // a stands at a2, which an older build dispatched with the pack key alone. b and c
    // recorded no pack. (The fallback to an item's other runs is itemStanding's own test.)
    const world: World = {
      mergedIds: ['item-a', 'item-c'],
      metadata: { a2: { dispatch: { base_branch: 'dev', pack: 'flow' } } },
    };
    const page = await readItemWindow(source(world), PROJECT, { ...wide, pack: 'flow' });
    expect(page.items.map(read => [read.item.key, read.standing.pack])).toEqual([['a', 'flow']]);
    expect(page.totals?.done).toBe(1);
  });

  test('an item stands by the items linked to it: done by its parts, waiting on what it depends on', async () => {
    const wide = { since: '2026-10-01T00:00:00Z', until: '2027-01-01T00:00:00Z' };
    type Link = [from: string, to: string, kind?: 'part_of' | 'depends_on' | 'ended'];
    const states = async (
      keys: string[],
      links: Link[],
      merged: string[],
      queuedOn: string[] = []
    ): Promise<[string, string][]> => {
      const items = keys.map(key => ({ id: `item-${key}`, projectKey: PROJECT, key }));
      const byKey = (key: string): WorkflowItem =>
        items.find(item => item.key === key) as WorkflowItem;
      const act = { at: '2026-11-01T00:00:00.000Z', via: 'cli', by: null, fromRun: null };
      const read = source({
        items,
        // Each item's one run ended with an outcome, nothing followed, and the engine
        // recorded the stop.
        stoppedOn: items.map(item => item.id),
        runsByItem: new Map(
          items.map(item => [
            item.id,
            [run(`${item.key}1`, item.id, 'build', '2026-11-02T00:00:00.000Z')],
          ])
        ),
        mergedIds: merged.map(key => `item-${key}`),
        queuedOn: queuedOn.map(key => `item-${key}`),
        links: links.map(([from, to, kind = 'part_of'], index) => ({
          id: `link-${String(index)}`,
          kind: kind === 'ended' ? 'part_of' : kind,
          from: byKey(from),
          to: byKey(to),
          ...act,
          ended: kind === 'ended' ? act : null,
        })),
      });
      return (await readItemWindow(read, PROJECT, wide)).items.map(item => [
        item.item.key,
        item.standing.state,
      ]);
    };
    const split: Link[] = [
      ['x', 'p'],
      ['y', 'p'],
    ];
    // p was split into x and y, both merged; x has a later start queued, and is still merged.
    expect(await states(['p', 'x', 'y'], split, ['x', 'y'], ['x'])).toEqual([
      ['p', 'done'],
      ['x', 'queued'],
      ['y', 'done'],
    ]);
    // y is not merged, so p is not done; its work goes on in y, so it needs no decision.
    expect(await states(['p', 'x', 'y'], split, ['x'])).toEqual([
      ['p', 'resting'],
      ['x', 'done'],
      ['y', 'stopped'],
    ]);
    // An ended link joins no part: y's no longer counts against p.
    expect(
      await states(
        ['p', 'x', 'y'],
        [
          ['x', 'p'],
          ['y', 'p', 'ended'],
        ],
        ['x']
      )
    ).toEqual([
      ['p', 'done'],
      ['x', 'done'],
      ['y', 'stopped'],
    ]);
    // A part is not done by its merged parent, and an item is not done by an item that
    // depends on it.
    expect(await states(['p', 'x'], [['x', 'p']], ['p'])).toEqual([
      ['p', 'done'],
      ['x', 'stopped'],
    ]);
    expect(await states(['p', 'x'], [['x', 'p', 'depends_on']], ['x'])).toEqual([
      ['p', 'stopped'],
      ['x', 'done'],
    ]);
    // x depends on p: while p is not done x waits for it, and once p merged x's stop is its own.
    expect(await states(['p', 'x'], [['x', 'p', 'depends_on']], [])).toEqual([
      ['p', 'stopped'],
      ['x', 'waiting'],
    ]);
    expect(await states(['p', 'x'], [['x', 'p', 'depends_on']], ['p'])).toEqual([
      ['p', 'done'],
      ['x', 'stopped'],
    ]);
    // A part split again is done by its own parts, and so is the item it is part of.
    expect(
      await states(
        ['p', 'x', 'z'],
        [
          ['z', 'x'],
          ['x', 'p'],
        ],
        ['z']
      )
    ).toEqual([
      ['p', 'done'],
      ['x', 'done'],
      ['z', 'done'],
    ]);
    // Two items part of each other: the read ends, neither is done, and both rest.
    expect(
      await states(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
        []
      )
    ).toEqual([
      ['a', 'resting'],
      ['b', 'resting'],
    ]);
    // One window read shares what it learned of linked items across them, but never an
    // answer a cycle cut (#286). Placing t meets d inside the cycle t, d and finds it not
    // done; placed on its own for u, d is done through t, whose part m merged, so u's wait
    // is over.
    const [t, d, m, u] = ['t', 'd', 'm', 'u'];
    const cycleRead = await states(
      [t, d, m, u],
      [
        [t, d, 'depends_on'],
        [t, d],
        [m, t],
        [u, d, 'depends_on'],
      ],
      [m]
    );
    expect(cycleRead.find(([key]) => key === u)).toEqual([u, 'stopped']);
  });

  test('an item whose runs cannot all be read is reported as degraded, and the rest of it reads', async () => {
    const page = await readItemWindow(source({ unreadable: ['a1'] }), PROJECT, NOVEMBER);
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
