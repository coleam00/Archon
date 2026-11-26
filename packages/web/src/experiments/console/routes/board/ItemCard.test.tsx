import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router';
import { NO_ITEM_ASKS } from '../../components/ItemAsksSection';
import type { FactoryView, RunRecord } from '../../factory/api';
import { CardsContext } from '../../factory/cards-context';
import type { CardPack } from '../../factory/lib/item-card';
import type { ItemAsk } from '../../primitives/run';
import type { ItemRead } from '../../skills/items';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { ProjectNeedsYouPage } from '../ProjectNeedsYouPage';
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
  changeSize: null,
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
    ended: null,
    workOrder: null,
    dependsOn: [],
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

/** Stands in for the project's Needs you tab: where a card's Needs you control lands. */
function NeedsYouTab(): ReactElement {
  return <p data-needs-you-tab>{useLocation().search}</p>;
}

/** The board's card list under the cards' shared state, as BoardPage mounts it. */
function Board({
  reads,
  packs = new Map(),
}: {
  reads: ItemRead[];
  packs?: Map<string, CardPack>;
}): ReactElement {
  return (
    <CardsContext.Provider
      value={{
        projectId: 'web',
        packs,
        packsError: false,
        itemAsks: { ...NO_ITEM_ASKS, asks: [ask], itemIds: new Set(['id-issue-2']) },
      }}
    >
      <CardList reads={reads} projectId="web" className="" />
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
          <Route path="/console/p/:projectId/needs-you" element={<NeedsYouTab />} />
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

test('a card with an open ask has one Needs you button at its bottom, beside its PR, to the filtered tab', async () => {
  const view = await mount(READS);
  try {
    const card = view.container.querySelector('[data-item="issue-2"]');
    const links = card?.querySelectorAll('[data-needs-you-link]') ?? [];
    expect(links.length).toBe(1);
    expect(links[0]?.textContent).toBe('Needs you · 1');
    expect(links[0]?.getAttribute('href')).toBe('/console/p/web/needs-you?item=issue-2');
    // The card's actions are its last row: the PR button, then the Needs you button beside it.
    const actions = card?.querySelector('[data-card-actions]');
    expect(actions).toBe(card?.lastElementChild ?? null);
    expect(links[0]?.parentElement === actions).toBe(true);
    expect(actions?.querySelector('[data-card-pr]')?.nextElementSibling).toBe(links[0] ?? null);
    // The top-right chip is the state as a label: a span, no link, no Needs you.
    const chips = card?.querySelectorAll('[data-chip]') ?? [];
    expect(chips.length).toBe(1);
    expect(chips[0]?.tagName).toBe('SPAN');
    expect(chips[0]?.closest('a')).toBeNull();
    expect(chips[0]?.hasAttribute('data-needs-you-link')).toBe(false);
    expect(chips[0]?.textContent).toBe('Waiting');
    // The card shows no ask question, recommendation or count beside it.
    expect(card?.textContent).not.toContain('Land it?');
    expect(card?.textContent).not.toContain('Recommended');
    expect(card?.textContent).not.toContain('open ask');
    expect(card?.querySelector('[data-card-pr]')?.textContent).toBe('Pull request');
  } finally {
    await view.unmount();
  }
});

test('a card with no open ask has no Needs you control', async () => {
  const view = await mount(READS);
  try {
    const card = view.container.querySelector('[data-item="issue-48"]');
    expect(card?.querySelector('[data-needs-you-link]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

test('an item that waits on a question with no open ask shows its state label, not a control', async () => {
  const base = READS[0]!;
  const read: ItemRead = {
    ...base,
    item: { ...base.item, id: 'id-issue-9', key: 'issue-9' },
    questions: [{ kind: 'ask', id: 'q1', message: 'Which way?' }],
  } as unknown as ItemRead;
  const view = await mount([read]);
  try {
    const card = view.container.querySelector('[data-item="issue-9"]');
    expect(card?.querySelector('[data-needs-you-link]')).toBeNull();
    const chip = card?.querySelector('[data-chip]');
    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.textContent).toBe('Waiting');
    expect(card?.querySelector('[data-card-actions] [data-needs-you-link]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

test('a failed card keeps its label top right and its PR as a button at its bottom', async () => {
  const base = READS[0]!;
  const failed: ItemRead = {
    ...base,
    item: { ...base.item, id: 'id-issue-5', key: 'issue-5' },
    standing: { ...base.standing, state: 'failed' },
  };
  const view = await mount([failed]);
  try {
    const card = view.container.querySelector('[data-item="issue-5"]');
    const chip = card?.querySelector('[data-chip]');
    expect(chip?.textContent).toBe('Failed');
    expect(chip?.closest('a')).toBeNull();
    // The reason stays above the actions row, which holds the PR.
    expect(card?.querySelector('[data-item-reason]')).not.toBeNull();
    expect(card?.lastElementChild?.hasAttribute('data-card-actions')).toBe(true);
    expect(card?.querySelector('[data-card-actions] [data-card-pr]')?.textContent).toBe(
      'Pull request'
    );
  } finally {
    await view.unmount();
  }
});

test("a failed card's reason names its stage by the view file's label, not its workflow id (#261)", async () => {
  const base = READS[0]!;
  const failed: ItemRead = {
    ...base,
    item: { ...base.item, id: 'id-issue-5', key: 'issue-5' },
    standing: { ...base.standing, state: 'failed' },
  };
  const packs = new Map<string, CardPack>([
    [
      'flow',
      {
        stages: [{ name: 'acme/flow:check', workflow: 'check', inFlow: true }],
        view: { stages: { check: { label: 'Checks' } } } as unknown as FactoryView,
      },
    ],
  ]);
  const view = await mount([failed], packs);
  try {
    const reason = view.container.querySelector('[data-item="issue-5"] [data-item-reason]');
    expect(reason?.textContent).toBe('Checks failed');
  } finally {
    await view.unmount();
  }
});

test("a card's Needs you N is the open-ask count of the tab its link opens, twins too (#225)", () => {
  const on = (ref: string, key: string): ItemAsk => ({
    ...ask,
    ref,
    item: { id: `id-${key}`, projectKey: 'acme/web', key },
  });
  // One issue keyed twice (`198` and `issue-198`), an ask on each, and an item of its own.
  const asks = [on('ask:t1', '198'), on('ask:t2', 'issue-198'), on('ask:t3', 'issue-7')];
  const reads = ['198', 'issue-198', 'issue-7'].map(key => ({
    ...item(key, [run(`run-${key}`, '2026-11-20T10:00:00.000Z')]),
    item: { id: `id-${key}`, projectKey: 'acme/web', key, title: `Title of ${key}` },
  }));
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks,
    answerRefusals: {},
    itemIds: new Set(reads.map(read => read.item.id)),
    degraded: [],
  });
  set(K.projects, []);
  set(K.boardOrders('web'), reads);
  const markup = (path: string, element: ReactElement): Document => {
    const page = new Window().document;
    page.body.innerHTML = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/console/p/:projectId/*" element={element} />
        </Routes>
      </MemoryRouter>
    );
    return page as unknown as Document;
  };
  const cards = markup(
    '/console/p/web/board',
    <CardsContext.Provider
      value={{
        projectId: 'web',
        packs: new Map(),
        packsError: false,
        itemAsks: { ...NO_ITEM_ASKS, asks },
      }}
    >
      <CardList reads={reads} projectId="web" className="" />
    </CardsContext.Provider>
  );
  try {
    const counts = reads.map(read => {
      const link = cards.querySelector(`[data-item="${read.item.key}"] [data-needs-you-link]`);
      const tab = markup(link?.getAttribute('href') ?? '', <ProjectNeedsYouPage />);
      return [link?.textContent, tab.querySelector('[role="status"]')?.textContent];
    });
    expect(counts).toEqual([
      ['Needs you · 2', '2 open asks'],
      ['Needs you · 2', '2 open asks'],
      ['Needs you · 1', '1 open ask'],
    ]);
  } finally {
    for (const prefix of ['projects', 'board', 'runs', 'forge-titles']) invalidate(prefix);
  }
});

test('the Needs you control opens the filtered Needs you tab, not the run log', async () => {
  const view = await mount(READS);
  try {
    await view.click(view.container.querySelector('[data-needs-you-link]'));
    expect(view.container.querySelector('[data-run-log]')).toBeNull();
    expect(view.container.querySelector('[data-needs-you-tab]')?.textContent).toBe('?item=issue-2');
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
    expect(card?.querySelector('[data-needs-you-link]')?.closest('a[data-card-link]')).toBeNull();
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
  stages: [{ name: 'acme/flow:check', workflow: 'check', inFlow: true }],
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
