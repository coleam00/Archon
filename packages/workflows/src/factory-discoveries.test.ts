import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readRunFixture } from './__fixtures__/read-run-fixture';
import {
  coveredBy,
  drainDecisions,
  factoryDiscoveriesSchema,
  readFactoryDiscoveries,
  type DiscoveriesSource,
} from './factory-discoveries';
import { hydrateRun, PACK, shippedView } from './factory-test.test-helpers';
import type { JsonValue } from './output-ref';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';

// The declaration this repository ships, with its `discoveries` field.
const view = shippedView();
const declaration = view.discoveries!;

/** A completed drain copied from the live factory database (see the file's `note`). */
const live = readRunFixture(
  join(import.meta.dir, '__fixtures__', 'factory-discoveries', 'drain-03398baa.jsonl')
);
type Result = { filed: Record<string, unknown>[]; held: unknown[]; dropped: unknown[] };
const liveValue = (live.events[0]!.data as { terminal_record: { returns: { value: Result } } })
  .terminal_record.returns.value;

const decided = (value: unknown): ReturnType<typeof drainDecisions> =>
  drainDecisions(declaration, value as JsonValue);

describe('what one drain decided', () => {
  test('filed entries with their kind and verified line; held and dropped counted', () => {
    const decisions = decided(liveValue);
    if (decisions === 'unreadable') throw new Error('the live drain reads');
    expect(decisions.held).toBe(2);
    expect(decisions.dropped).toBe(1);
    expect(decisions.filed).toHaveLength(1);
    expect(decisions.filed[0]).toEqual({
      title: liveValue.filed[0]!.title as string,
      kind: 'defect',
      verified: (liveValue.filed[0]!.verified as string).trim(),
    });
  });

  test.each<[string, unknown, ReturnType<typeof drainDecisions>]>([
    [
      'a drain that noticed nothing decided nothing, and still reads',
      { summary: 'Nothing.', filed: [], folded: [], held: [], dropped: [] },
      { filed: [], held: 0, dropped: 0 },
    ],
    [
      'a filed entry with no kind or verified line reads them null',
      { filed: [{ title: 'A thing' }], held: [], dropped: [] },
      { filed: [{ title: 'A thing', kind: null, verified: null }], held: 0, dropped: 0 },
    ],
    [
      'a filed entry with no title is unreadable',
      { filed: [{ kind: 'defect' }], held: [], dropped: [] },
      'unreadable',
    ],
  ])('%s', (_name, value, expected) => {
    expect(decided(value)).toEqual(expected);
  });
});

test('a finding is covered by an item with the same title, in any case, trimmed; a near title does not', () => {
  const titles = new Map<string, string | null>([
    ['5', 'The board reads well'],
    ['9', null],
    ['12', ' An order with runs but no title reads "48 48" '],
  ]);
  expect(coveredBy('an ORDER with runs but no title reads "48 48"', titles)).toBe('12');
  expect(coveredBy('An order with runs but no title reads "48"', titles)).toBeNull();
  expect(coveredBy('The board reads well.', titles)).toBeNull();
  // A title an item's title extends is not the same title either.
  expect(coveredBy('The board reads', titles)).toBeNull();
});

const run = (fields: Partial<WorkflowRun> & Pick<WorkflowRun, 'id' | 'workflow_name'>) =>
  hydrateRun({
    status: 'completed',
    started_at: '2026-11-17T10:00:00Z',
    completed_at: '2026-11-17T10:05:00Z',
    ...fields,
  });
/** A run of the item's own workflow, carrying the item text its title comes from. */
const titled = (id: string, title: string): WorkflowRun =>
  run({
    id,
    workflow_name: `${PACK}:triage`,
    metadata: { inputs: { item: `---\nid: 1\n---\n\n# ${title}\n\nBody.` } },
  });

const completedEvent = (
  runId: string,
  value: unknown,
  availability = 'available'
): WorkflowEventRow => {
  const event = structuredClone(live.events[0]!);
  const data = event.data as {
    terminal_record: { run_id: string; returns: Record<string, unknown> };
  };
  data.terminal_record.run_id = runId;
  data.terminal_record.returns =
    availability === 'available'
      ? { ...data.terminal_record.returns, value }
      : { availability, node_id: 'drain', reason: 'output_not_persisted' };
  return { ...event, id: `ev-${runId}`, workflow_run_id: runId };
};

function source(
  items: readonly WorkflowItem[],
  runs: Record<string, WorkflowRun[]>,
  events: readonly WorkflowEventRow[]
): DiscoveriesSource & { pages: number } {
  const fake = {
    pages: 0,
    listItemsInWindow: async ({
      afterItemId,
      limit,
    }: {
      afterItemId: string | null;
      limit: number;
    }) => {
      fake.pages += 1;
      const from = afterItemId === null ? 0 : items.findIndex(item => item.id === afterItemId) + 1;
      return items.slice(from, from + limit);
    },
    getItemRuns: async (_projectKey: string, key: string) => {
      const item = items.find(entry => entry.key === key);
      return item === undefined ? null : { item, runs: runs[key] ?? [], descendantIds: [] };
    },
    listEventsForRuns: async (ids: readonly string[]) =>
      new Map(ids.map(id => [id, events.filter(row => row.workflow_run_id === id)])),
  };
  return fake as unknown as DiscoveriesSource & { pages: number };
}

describe('reading every drain on the project', () => {
  const item = (n: number): WorkflowItem => ({
    id: `id-${String(n)}`,
    projectKey: 'acme/web',
    key: String(n),
  });
  const drain = (id: string, completedAt: string, status: WorkflowRun['status'] = 'completed') =>
    run({
      id,
      workflow_name: `${PACK}:discoveries`,
      status,
      completed_at: status === 'completed' ? new Date(completedAt) : null,
    });
  const coveredTitle = liveValue.filed[0]!.title as string;

  test('findings newest drain first, each covered by a same-titled item, other runs ignored', async () => {
    const read = await readFactoryDiscoveries(
      source(
        [item(1), item(2), item(3)],
        {
          '1': [titled('t1', 'First item'), drain('d1', '2026-11-17T17:03:26Z')],
          // Its title is the live drain's finding, in another case: it covers it.
          '2': [titled('t2', coveredTitle.toUpperCase()), drain('d2', '2026-11-18T09:00:00Z')],
          // A drain still running and a completed run of another workflow decide nothing.
          '3': [titled('t3', 'Third'), drain('d3', '', 'running')],
        },
        [
          completedEvent('d1', liveValue),
          completedEvent('d2', {
            filed: [{ title: 'A newer finding', kind: 'cleanup' }],
            held: [],
            dropped: [{ what: 'x', why: 'y' }],
          }),
          completedEvent('t3', { filed: [{ title: 'Not a drain' }], held: [], dropped: [] }),
        ]
      ),
      { view, pack: PACK, projectKey: 'acme/web' }
    );
    expect(factoryDiscoveriesSchema.parse(read)).toEqual(read);
    expect(read).toMatchObject({
      pack: PACK,
      shadow: true,
      unreadable: 0,
      held: 2,
      dropped: 2,
    });
    expect(read.findings.map(f => [f.title, f.kind, f.from, f.coveredBy, f.runId])).toEqual([
      ['A newer finding', 'cleanup', { key: '2', title: coveredTitle.toUpperCase() }, null, 'd2'],
      [coveredTitle, 'defect', { key: '1', title: 'First item' }, '2', 'd1'],
    ]);
    expect(read.findings[1]?.decidedAt).toBe('2026-11-17T17:03:26.000Z');
  });

  test('a drain whose result is text holding JSON reads; text that is not JSON does not', async () => {
    const unreadable: string[] = [];
    const read = await readFactoryDiscoveries(
      source(
        [item(1)],
        { '1': [drain('d1', '2026-11-17T17:03:26Z'), drain('d2', '2026-11-17T18:00:00Z')] },
        [
          completedEvent('d1', JSON.stringify(liveValue)),
          completedEvent('d2', 'Filed one finding.'),
        ]
      ),
      { view, pack: PACK, projectKey: 'acme/web', onUnreadable: id => unreadable.push(id) }
    );
    expect(read.findings.map(f => f.runId)).toEqual(liveValue.filed.map(() => 'd1'));
    expect(unreadable).toEqual(['d2']);
  });

  test('reads past the first page of items', async () => {
    const items = Array.from({ length: 101 }, (_, n) => item(n + 1));
    const fake = source(items, { '101': [drain('d1', '2026-11-17T17:03:26Z')] }, [
      completedEvent('d1', liveValue),
    ]);
    const read = await readFactoryDiscoveries(fake, { view, pack: PACK, projectKey: 'acme/web' });
    expect(fake.pages).toBe(2);
    expect(read.findings.map(f => f.from.key)).toEqual(['101']);
  });
});
