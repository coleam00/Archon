import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { NO_ITEM_ASKS } from '../../components/ItemAsksSection';
import type { FactoryView, RunRecord } from '../../factory/api';
import { CardsContext, type OpenAsks } from '../../factory/cards-context';
import type { CardPack } from '../../factory/lib/item-card';
import { ItemAsksPopover } from '../../factory/ItemAsksPopover';
import type { ItemAsk } from '../../primitives/run';
import type { ItemRead } from '../../skills/items';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { CardList } from './ItemCard';

const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const run = (id: string, startedAt: string): ItemRead['runs'][number] => ({
  id,
  workflow: 'acme/flow:check',
  pack: { key: 'flow', workflow: 'check' },
  status: 'completed',
  outcome: 'ask',
  startedAt,
  completedAt: startedAt,
  cause: null,
  awaitingExecution: null,
  startLimit: null,
  spend: { usd: null, inputTokens: null, outputTokens: null },
  heldBehind: null,
  operatorPause: null,
  hasResult: false,
  resultCommit: null,
});

function item(key: string, runs: ItemRead['runs']): ItemRead {
  return {
    item: { id: `id-${key}`, projectKey: 'acme/web', key, title: `Title of ${key}` },
    standing: {
      runId: runs[0]?.id ?? null,
      state: 'waiting',
      pack: runs.length === 0 ? null : 'flow',
    },
    runs,
    queued: [],
    skipped: [],
    hold: null,
    held: [],
    runLimit: null,
    startLimits: [],
    waits: [],
    questions: [],
    answers: [],
    links: [],
    merged:
      runs.length === 0
        ? null
        : {
            change: 'https://example.test/acme/web/pull/7',
            commit: null,
            at: '2026-11-20T10:00:00.000Z',
            recordedAt: '2026-11-20T10:00:00.000Z',
            via: 'cli',
            fromRun: null,
          },
    landing: null,
    degraded: [],
  } as ItemRead;
}

const ask: ItemAsk = {
  kind: 'attention',
  ref: 'ask:a1',
  project: { key: 'acme/web', codebaseId: 'web', name: 'web' },
  item: { id: 'id-issue-2', projectKey: 'acme/web', key: 'issue-2' },
  revision: 1,
  labels: {},
  pausedAt: null,
  message: 'Land it?',
  form: 'select',
  options: [
    { id: 'land', label: 'Land it now', does: 'Lands it.', cost: 'Nothing.' },
    { id: 'hold', does: 'Holds it.', cost: 'Time.' },
  ],
  recommendation: { option: 'land', why: 'It is ready.' },
};

function RunLog(): ReactElement {
  return <p data-run-log>{useParams().runId}</p>;
}

/** The board's card list under the cards' shared state, with the popover, as BoardPage mounts them. */
function Board({
  reads,
  packs = new Map(),
}: {
  reads: ItemRead[];
  packs?: Map<string, CardPack>;
}): ReactElement {
  const [open, setOpen] = useState<OpenAsks | null>(null);
  return (
    <CardsContext.Provider
      value={{
        projectId: 'web',
        packs,
        packsError: false,
        itemAsks: { ...NO_ITEM_ASKS, asks: [ask], itemIds: new Set(['id-issue-2']) },
        open,
        setOpen,
      }}
    >
      <CardList reads={reads} projectId="web" className="" />
      <ItemAsksPopover />
    </CardsContext.Provider>
  );
}

async function mount(reads: ItemRead[], packs?: Map<string, CardPack>) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/console/p/web/board']}>
        <Routes>
          <Route
            path="/console/p/:projectId/board"
            element={<Board reads={reads} packs={packs} />}
          />
          <Route path="/console/p/:projectId/r/:runId" element={<RunLog />} />
        </Routes>
      </MemoryRouter>
    )
  );
  return {
    container,
    click: async (element: Element | null | undefined) => {
      if (element == null) throw new Error('nothing to click');
      await act(async () => {
        (element as HTMLElement).click();
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const READS = [
  item('issue-2', [
    run('run-old', '2026-11-19T10:00:00.000Z'),
    run('run-2', '2026-11-20T10:00:00.000Z'),
  ]),
  item('issue-48', []),
];

test('a card with an open ask shows the recommended label from the ask record and the count', async () => {
  const view = await mount(READS);
  try {
    const card = view.container.querySelector('[data-item="issue-2"]');
    expect(card?.querySelector('[data-card-recommended]')?.textContent).toBe(
      'Recommended: Land it now'
    );
    expect(card?.querySelector('[data-card-open-asks]')?.textContent).toBe('1 open ask');
    expect(card?.querySelector('[data-card-pr]')?.textContent).toBe('Pull request');
  } finally {
    await view.unmount();
  }
});

test('the asks button opens Archon’s ask section in a popover and does not open the run log', async () => {
  const view = await mount(READS);
  try {
    await view.click(view.container.querySelector('[data-card-asks]'));
    expect(view.container.querySelector('[data-run-log]')).toBeNull();
    const popover = document.querySelector('[data-item-asks-popover="id-issue-2"]');
    expect(popover?.querySelector('[data-ask-ref="ask:a1"]')?.textContent).toContain('Land it?');
  } finally {
    await view.unmount();
  }
});

test('the PR link is not the run log; a press elsewhere on the card opens the run log', async () => {
  const view = await mount(READS);
  try {
    const card = view.container.querySelector('[data-item="issue-2"]');
    // The card-wide link is the card's sibling layer, never an ancestor of its inner controls.
    expect(card?.querySelector('[data-card-pr]')?.closest('a[data-card-link]')).toBeNull();
    expect(card?.querySelector('[data-card-asks]')?.closest('a')).toBeNull();
    await view.click(card?.querySelector('[data-card-link]'));
    // It opens the run the item stands at.
    expect(view.container.querySelector('[data-run-log]')?.textContent).toBe('run-old');
  } finally {
    await view.unmount();
  }
});

test('an item with no run is not a link', async () => {
  const view = await mount(READS);
  try {
    const card = view.container.querySelector('[data-item="issue-48"]');
    expect(card?.querySelector('a')).toBeNull();
  } finally {
    await view.unmount();
  }
});

/** Pack `flow`: each `check` run is one check round, numbered in its result; its judge returns. */
const FLOW: CardPack = {
  stages: [{ name: 'acme/flow:check', workflow: 'check' }],
  view: {
    stages: { check: { label: 'Check', blurb: 'x' } },
    words: { rounds: 'check rounds', sentBack: 'sent back' },
    rounds: { workflow: 'check', round: '/round', allowance: '/allowance' },
    returns: [{ workflow: 'check', node: 'judge', outcome: 'return' }],
  } as unknown as FactoryView,
};

const record = (id: string, round: number, outcome: string): RunRecord => ({
  id,
  status: 'completed',
  completed_at: null,
  returns: { availability: 'available', node_id: 'end', value: { round, allowance: 3 } },
  node_outcomes: {
    run_id: id,
    first_failed_node: null,
    nodes: [{ node_id: 'judge', state: 'completed', output: { outcome, summary: `Judged ${id}` } }],
  },
  loop_iterations: [],
  running: [],
});

test('a card shows its rounds and returns from the run records its list read', async () => {
  // What `useCardList` asks for: the item's runs of declared workflows (key 'x' names no issue).
  set(K.cardReads('web', ['run-2', 'run-old']), {
    records: [record('run-old', 1, 'return'), record('run-2', 2, 'approve')],
    missing: [],
    unreadable: [],
  });
  const read = { ...READS[0]!, item: { ...READS[0]!.item, key: 'x' } };
  const view = await mount([read], new Map([['flow', FLOW]]));
  try {
    const card = view.container.querySelector('[data-item="x"]');
    expect(card?.querySelector('[data-card-rounds]')?.textContent).toBe('2 of 3 check rounds');
    const returned = card?.querySelector('[data-card-returned]');
    expect(returned?.textContent).toBe('sent back 1x');
    expect(returned?.getAttribute('title')).toBe('Judged run-old');
  } finally {
    await view.unmount();
    invalidate('board');
  }
});

test('a run record the list could not read says so instead of showing no rounds', async () => {
  set(K.cardReads('web', ['run-2', 'run-old']), {
    records: [],
    missing: [],
    unreadable: [{ id: 'run-2', error: 'x' }],
  });
  const read = { ...READS[0]!, item: { ...READS[0]!.item, key: 'x' } };
  const view = await mount([read], new Map([['flow', FLOW]]));
  try {
    const card = view.container.querySelector('[data-item="x"]');
    expect(card?.querySelector('[data-card-unread]')).not.toBeNull();
  } finally {
    await view.unmount();
    invalidate('board');
  }
});

test('an item whose title column is empty shows its issue title from the forge', async () => {
  // What `useCardList` asks the forge for: issue 2, the number `issue-2` names.
  set(K.forgeTitles('web', [2]), {
    issues: [{ number: 2, title: 'Issue title', state: 'open', url: null, pending: false }],
    changes: [],
  });
  const read = { ...READS[0]!, item: { ...READS[0]!.item, title: null } };
  const view = await mount([read]);
  try {
    const card = view.container.querySelector('[data-item="issue-2"]');
    expect(card?.querySelector('[data-item-title]')?.textContent).toBe('Issue title');
    expect(card?.querySelector('[data-item-key]')?.textContent).toBe('#2');
  } finally {
    await view.unmount();
    invalidate('forge-titles');
  }
});

test("a running run shows its stage and step in the view's words", async () => {
  const running: RunRecord = {
    ...record('run-2', 2, 'approve'),
    status: 'running',
    running: ['judge'],
  };
  set(K.cardReads('web', ['run-2', 'run-old']), {
    records: [record('run-old', 1, 'return'), running],
    missing: [],
    unreadable: [],
  });
  const base = READS[0]!;
  const read = {
    ...base,
    item: { ...base.item, key: 'x' },
    runs: base.runs.map(run => (run.id === 'run-2' ? { ...run, status: 'running' as const } : run)),
  };
  const view = await mount([read], new Map([['flow', FLOW]]));
  try {
    const card = view.container.querySelector('[data-item="x"]');
    expect(card?.querySelector('[data-card-running]')?.textContent).toBe('Check · judge');
  } finally {
    await view.unmount();
    invalidate('board');
  }
});

test('a title the forge first answers pending fills in when it is read again', async () => {
  // An item keyed by its bare issue number, as the deliver era keyed them.
  const title = 'A delivery ask shows what the stage offered, above the four answers';
  const answer = (pending: boolean) => ({
    issues: [{ number: 111, title: pending ? null : title, state: 'closed', url: null, pending }],
    changes: [],
  });
  set(K.forgeTitles('web', [111]), answer(true));
  const asked: string[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: (url: string) => {
      asked.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify(answer(false)), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    },
  });
  const read = { ...READS[0]!, item: { ...READS[0]!.item, key: '111', title: null } };
  const view = await mount([read]);
  try {
    const card = (): Element | null => view.container.querySelector('[data-item="111"]');
    expect(card()?.querySelector('[data-item-title]')).toBeNull();
    expect(card()?.querySelector('[data-item-key]')?.textContent).toBe('#111');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2300));
    });
    expect(
      asked.some(url => url.includes('/api/forge/subjects') && url.includes('issue=111'))
    ).toBe(true);
    expect(card()?.querySelector('[data-item-title]')?.textContent).toBe(title);
  } finally {
    await view.unmount();
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    invalidate('forge-titles');
  }
});
