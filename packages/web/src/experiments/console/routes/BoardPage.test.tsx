import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { BoardPage, PackBoard } from './BoardPage';
import { OverviewPage } from './OverviewPage';
import { packBoard } from '../factory/lib/board-numbers';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import type { Project } from '../primitives/project';
import type { ItemAsk } from '../primitives/run';
import type { ItemRead, PackGraph } from '../skills/items';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';

afterEach(() => {
  for (const prefix of ['projects', 'board', 'pack-graph', 'runs']) invalidate(prefix);
});

const project = (id: string, itemPacks: string[]): Project => ({
  id,
  name: id,
  path: `/work/${id}`,
  defaultBranch: 'main',
  repositoryUrl: null,
  lastSyncedAt: null,
  kind: 'repo',
  itemPacks,
});

/** An item whose one run of `stage` (a workflow of pack `flow`, or of no pack) stands as `state`. */
function item(key: string, stage: string | null, state: ItemRead['standing']['state']): ItemRead {
  return {
    item: { id: `id-${key}`, projectKey: 'acme/web', key, title: `Title of ${key}` },
    standing: { runId: `run-${key}`, state, pack: stage === null ? null : 'flow' },
    runs: [
      {
        id: `run-${key}`,
        workflow: stage ?? 'by-hand',
        pack: stage === null ? null : { key: 'flow', workflow: stage },
        status: state === 'running' ? 'running' : 'completed',
        outcome: null,
        startedAt: '2026-11-20T10:00:00.000Z',
        completedAt: null,
        cause: null,
        awaitingExecution: null,
        startLimit: null,
        spend: { usd: null, inputTokens: null, outputTokens: null },
        heldBehind: null,
        operatorPause: null,
        hasResult: false,
        resultCommit: null,
      },
    ],
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
    merged: null,
    landing: null,
    degraded: [],
  };
}

const graph: PackGraph = {
  pack: 'flow',
  loaded: [],
  otherCopies: [],
  // The order the engine gives, which is not alphabetical.
  stages: ['plan', 'lint', 'build', 'check'].map(workflow => ({
    name: `acme/flow:${workflow}`,
    workflow,
    entry: workflow === 'plan',
    roles: [],
    // `lint` is a workflow of the pack that only other workflows call.
    inFlow: workflow !== 'lint',
    returns: null,
    outcome: null,
    asks: false,
    waits: false,
    nodes: [],
  })),
  entries: [],
  document: null,
  metricViews: null,
  groups: [],
  arrows: [],
  capacity: [],
  settings: [],
  settingsFile: { path: '.archon/packs/flow.yaml', problems: [] },
  fanOutBlocks: [],
  discoveryErrors: [],
};

/** No item in any state. */
const NONE = { running: 0, waiting: 0, queued: 0, failed: 0, stopped: 0, done: 0, resting: 0 };

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
  options: [{ id: 'land', does: 'Lands it.', cost: 'Nothing.' }],
};

function render(path: string, element: React.ReactElement): Document {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/p/:projectId/*" element={element} />
      </Routes>
    </MemoryRouter>
  );
  const dom = new Window();
  dom.document.body.innerHTML = html;
  return dom.document as unknown as Document;
}

const keysIn = (scope: ParentNode): string[] =>
  [...scope.querySelectorAll('[data-item]')].map(card => card.getAttribute('data-item') ?? '');

test('each open item is under the stage it stands at, in the order the pack graph gives', () => {
  set(K.projects, [project('web', ['flow'])]);
  set(K.board('web'), [
    // Part of a work order, which is not itself open.
    {
      ...item('issue-1', 'check', 'running'),
      links: [
        {
          id: 'link-1',
          kind: 'part_of',
          direction: 'outgoing',
          other: {
            id: 'id-order-9',
            projectKey: 'acme/web',
            key: 'order-9',
            title: 'Redo checkout',
          },
          at: '2026-11-20T09:00:00.000Z',
          via: 'cli',
          by: null,
          fromRun: null,
          ended: null,
        },
      ],
    },
    { ...item('issue-2', 'plan', 'waiting'), questions: [ask] },
    // A stage the pack no longer has stays on the board; a run of no pack waits to be asked for.
    item('issue-4', 'retired', 'queued'),
    item('issue-5', null, 'running'),
  ]);
  set(K.packGraph('web', 'flow'), graph);
  // A failed item is read apart from the ones on a stage.
  set(K.boardDecide('web'), {
    items: [item('issue-3', 'check', 'failed')],
    next: null,
    totals: { ...NONE, failed: 1 },
  });
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [ask],
    answerRefusals: {},
    itemIds: new Set(['id-issue-2']),
    degraded: [],
  });

  const page = render('/console/p/web/board', <BoardPage />);
  const pack = page.querySelector('[data-pack="flow"]');
  if (pack === null) throw new Error('Expected the pack on the board');
  expect(
    [...pack.querySelectorAll('[data-stage]')].map(stage => [
      stage.getAttribute('data-stage'),
      keysIn(stage),
    ])
  ).toEqual([
    // `lint`, which only other workflows call, is no stage. The failed item is on none.
    ['plan', ['issue-2']],
    ['build', []],
    ['check', ['issue-1']],
    ['Not on a stage', ['issue-4']],
  ]);
  const decide = page.querySelector('[data-needs-decision]');
  expect(decide === null ? [] : keysIn(decide)).toEqual(['issue-3']);
  expect(decide?.querySelector('[data-item-reason]')?.textContent).toContain('check');
  expect(page.querySelector('[data-outside-pack]')).not.toBeNull();
  expect(keysIn(page)).not.toContain('issue-5');

  // An item shows its title, links to its run, and says how it stands.
  const card = page.querySelector('[data-item="issue-3"]');
  expect(card?.getAttribute('data-state')).toBe('failed');
  expect(card?.querySelector('[data-item-title]')?.textContent).toBe('Title of issue-3');
  expect(card?.querySelector('a')?.getAttribute('href')).toBe('/console/p/web/r/run-issue-3');
  // An item that waits on the operator says so.
  expect(page.querySelector('[data-item="issue-2"] [data-chip]')?.getAttribute('data-chip')).toBe(
    'needs_you'
  );
  // Until every item is read, the work orders are a skeleton: no total that may be wrong.
  expect(page.querySelector('[data-work-orders-loading]')).not.toBeNull();
  expect(page.querySelector('[data-work-order]')).toBeNull();
  // The Board has no Needs you section (that is its own tab); the item that has an ask opens it
  // over its card.
  expect(page.querySelector('[data-needs-you]')).toBeNull();
  const asks = page.querySelector('[data-item="issue-2"] [data-card-asks]');
  expect(asks?.textContent).toContain('1 open ask');
  // The ask declares no recommendation, which the card says without reading its text.
  expect(asks?.querySelector('[data-card-no-recommendation]')?.textContent).toBe(
    'No recommendation'
  );
});

/** An active `part_of` link from an item to work order `key`. */
function partOf(key: string, title: string | null): ItemRead['links'][number] {
  return {
    id: `link-${key}`,
    kind: 'part_of',
    direction: 'outgoing',
    other: { id: `id-${key}`, projectKey: 'acme/web', key, title },
    at: '2026-11-20T09:00:00.000Z',
    via: 'cli',
    by: null,
    fromRun: null,
    ended: null,
  };
}

test('a work order with no run of its own is listed from its members, open or merged', () => {
  set(K.projects, [project('web', ['flow'])]);
  // An item whose standing run recorded its pack's key without the workflow's name; the run
  // carries the stage's published name.
  const older = item('issue-7', 'build', 'running');
  const build = {
    ...older,
    runs: older.runs.map(run => ({ ...run, workflow: 'acme/flow:build', pack: null })),
  };
  set(K.board('web'), [build]);
  set(K.packGraph('web', 'flow'), graph);
  set(K.boardDecide('web'), { items: [], next: null, totals: NONE });
  const merged = (key: string, order: string): ItemRead => ({
    ...item(key, 'check', 'done'),
    links: [partOf(order, null)],
    merged: {
      change: `https://example.test/pull/${key}`,
      commit: null,
      at: '2026-11-19T10:00:00.000Z',
      recordedAt: '2026-11-19T10:00:00.000Z',
      via: 'cli',
      fromRun: null,
    },
  });
  // Order 48 has no run of its own; its read names a third member, 9, that has not started.
  const incoming = (key: string): ItemRead['links'][number] => ({
    ...partOf(key, null),
    id: `link-in-${key}`,
    direction: 'incoming',
  });
  const order48: ItemRead = {
    ...item('48', null, 'resting'),
    item: { id: 'id-48', projectKey: 'acme/web', key: '48', title: 'Split the board' },
    standing: { runId: null, state: 'resting', pack: null },
    runs: [],
    links: [incoming('issue-1'), incoming('issue-2'), incoming('9')],
  };
  // Newest first: the merged members are newer than the open one, so only the sort puts
  // the open order first.
  set(K.boardOrders('web'), [
    merged('issue-1', '48'),
    merged('issue-2', '48'),
    { ...item('issue-8', 'plan', 'running'), links: [partOf('order-5', 'Open order')] },
    order48,
    build,
    // Order 64's only member merged, and its own read stands done: resolved.
    merged('issue-10', '64'),
    {
      ...order48,
      item: { ...order48.item, id: 'id-64', key: '64' },
      standing: { runId: null, state: 'done', pack: null },
      links: [incoming('issue-10')],
    },
  ]);
  const page = render('/console/p/web/board', <BoardPage />);
  const strips = [...page.querySelectorAll('[data-work-order]')];
  // The order with an open member comes first.
  expect(
    strips.map(strip => [
      strip.getAttribute('data-work-order'),
      strip.querySelector('[data-work-order-line]')?.textContent,
      strip.querySelector('[data-work-order-unstarted]')?.textContent,
      strip.hasAttribute('data-resolved'),
    ])
  ).toEqual([
    ['order-5', '0 of 1 merged', undefined, false],
    // A member is not started, so the order's read stands at rest: not resolved.
    ['48', '2 of 3 merged', '1 not started', false],
    ['64', '1 of 1 merged', undefined, true],
  ]);
  expect(strips[2]?.querySelector('[data-work-order-resolved]')?.textContent).toBe('Resolved');
  expect(page.querySelector('[data-work-orders]')?.textContent).toContain('3 work orders · 2 open');
  // An order with a read of its own goes by its own title.
  expect(strips[1]?.textContent).toContain('Split the board');
  // Its key reads as a person reads an issue key: #48.
  expect(strips[1]?.querySelector('[data-work-order-key]')?.textContent).toBe('#48');
  // The item counts for the pack its run recorded, and its run's name finds its stage.
  const pack = page.querySelector('[data-pack="flow"]');
  expect(pack?.querySelector('[data-stage="build"]')?.getAttribute('data-empty')).toBeNull();
  expect(keysIn(pack?.querySelector('[data-stage="build"]') ?? page.createElement('div'))).toEqual([
    'issue-7',
  ]);
  expect(page.querySelector('[data-outside-pack]')).toBeNull();
});

test('stages a pack groups share a column, and each card there says its own stage', () => {
  set(K.packGraph('web', 'flow'), {
    ...graph,
    groups: [{ name: 'Make', stages: ['plan', 'build'] }],
  });
  const page = render(
    '/console/p/web/board',
    <PackBoard
      projectId="web"
      pack="flow"
      board={packBoard(
        [item('issue-1', 'build', 'running'), item('issue-2', 'plan', 'queued')],
        'flow',
        new Date()
      )}
      counted
    />
  );
  expect(
    [...page.querySelectorAll('[data-stage]')].map(column => [
      column.getAttribute('data-stage'),
      keysIn(column),
    ])
  ).toEqual([
    ['Make', ['issue-1', 'issue-2']],
    ['check', []],
  ]);
  expect(page.querySelector('[data-item="issue-2"]')?.textContent).toContain('plan');
});

test('only a project with an item on a pack stage gets the board tab', () => {
  set(K.projects, [project('web', ['flow']), project('docs', [])]);
  const tabs = (id: string): (string | null)[] =>
    [
      ...render(
        `/console/p/${id}`,
        <ProjectViewTabs projectId={id} active="runs" />
      ).querySelectorAll('a'),
    ].map(link => link.getAttribute('href'));
  expect(tabs('web')).toContain('/console/p/web/board');
  expect(tabs('web').slice(0, 2)).toEqual(['/console/p/web/needs-you', '/console/p/web']);
  expect(tabs('docs')).toEqual([
    '/console/p/docs/needs-you',
    '/console/p/docs',
    '/console/p/docs/chat',
    '/console/p/docs/metrics',
  ]);
});

const untitled = (key: string, stage: string): ItemRead => {
  const read = item(key, stage, 'waiting');
  return { ...read, item: { ...read.item, title: null } };
};

/** What a mounted board reads apart from its pack graph and view, seeded so nothing is fetched. */
function seedBoard(reads: ItemRead[]): void {
  set(K.projects, [project('web', ['flow'])]);
  set(K.board('web'), reads);
  set(K.boardOrders('web'), reads);
  set(K.boardDecide('web'), { items: [], next: null, totals: NONE });
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [],
    answerRefusals: {},
    itemIds: new Set(),
    degraded: [],
  });
}

/**
 * The board mounted in happy-dom, with its globals installed for this test only and `fetch`
 * answered by `answer`. `unmount` restores both.
 */
async function mountBoard(answer: (url: string) => Promise<Response>) {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string) => answer(String(url)),
  };
  const saved = new Map(
    Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/console/p/web/board']}>
        <Routes>
          <Route path="/console/p/:projectId/*" element={<BoardPage />} />
        </Routes>
      </MemoryRouter>
    )
  );
  return {
    dom,
    container,
    act,
    unmount: async (): Promise<void> => {
      await act(async () => root.unmount());
      await dom.happyDOM.close();
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      for (const prefix of ['forge-titles', 'pack-view']) invalidate(prefix);
    },
  };
}

const nothingFetched = (url: string): Promise<Response> =>
  Promise.reject(new Error(`unexpected fetch ${url}`));

test('the board filter finds a card by the issue title and the key the card prints', async () => {
  const issue = (number: number, title: string) => ({
    number,
    title,
    state: 'open' as const,
    url: null,
    pending: false,
  });
  const reads = [untitled('issue-2', 'plan'), untitled('issue-3', 'check')];
  seedBoard(reads);
  set(K.packGraph('web', 'flow'), graph);
  set(K.packView('web', 'flow'), { path: null, view: null, problems: [] });
  // The titles the board's filter reads, and those each column's cards read.
  const titles = [issue(2, 'Asks show in full'), issue(3, 'Board furniture')];
  set(K.forgeTitles('web', [2, 3]), { issues: titles, changes: [] });
  set(K.forgeTitles('web', [2]), { issues: [titles[0]], changes: [] });
  set(K.forgeTitles('web', [3]), { issues: [titles[1]], changes: [] });
  const board = await mountBoard(nothingFetched);
  const { container, dom, act } = board;
  const shown = (): string[] =>
    [...container.querySelectorAll('[data-stage] [data-item]')].map(
      card => card.getAttribute('data-item') ?? ''
    );
  const type = async (text: string): Promise<void> => {
    const input = container.querySelector('input[aria-label="Filter items"]');
    if (input === null) throw new Error('Expected the filter');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        text
      );
      input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    });
  };
  try {
    expect(shown()).toEqual(['issue-2', 'issue-3']);
    // The title the forge names, which the item's own title column does not hold.
    await type('asks show');
    expect(shown()).toEqual(['issue-2']);
    // The key as the card prints it, which the raw key `issue-3` does not contain.
    await type('#3');
    expect(shown()).toEqual(['issue-3']);
  } finally {
    await board.unmount();
  }
});

test("the stage columns' graph read goes alone: the cards share it, then read the view and the forge", async () => {
  // Untitled issue-keyed items, whose cards ask the forge for their titles: one in a column,
  // which waits on the graph, and one in the decision strip, which draws at once.
  const reads = [untitled('issue-2', 'plan')];
  seedBoard(reads);
  const failed = item('issue-3', 'check', 'failed');
  set(K.boardDecide('web'), {
    items: [{ ...failed, item: { ...failed.item, title: null } }],
    next: null,
    totals: { ...NONE, failed: 1 },
  });
  const asked: string[] = [];
  let answerGraph: () => void = () => undefined;
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const board = await mountBoard(url => {
    asked.push(url.replace(/\?.*$/, ''));
    if (url.includes('/graph'))
      return new Promise(resolve => {
        answerGraph = () => {
          resolve(json(graph));
        };
      });
    if (url.includes('/view'))
      return Promise.resolve(json({ path: null, view: null, problems: [] }));
    if (url.includes('/forge/subjects')) return Promise.resolve(json({ issues: [], changes: [] }));
    return nothingFetched(url);
  });
  try {
    // While the graph read is out: one request for it, and none for the view or the forge.
    expect(asked).toEqual(['/api/packs/flow/graph']);
    await board.act(async () => {
      answerGraph();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(board.container.querySelectorAll('[data-stage]').length).toBeGreaterThan(0);
    // Then the view, and the forge for each list's titles (the column's and the strip's).
    expect(asked.slice(0, 2)).toEqual(['/api/packs/flow/graph', '/api/packs/flow/view']);
    expect(asked.slice(2)).toEqual(['/api/forge/subjects', '/api/forge/subjects']);
  } finally {
    await board.unmount();
  }
});

test('while the project is still read, its packs are unknown and no card asks the forge', async () => {
  const failed = item('issue-3', 'check', 'failed');
  seedBoard([]);
  invalidate('projects');
  set(K.boardDecide('web'), {
    items: [{ ...failed, item: { ...failed.item, title: null } }],
    next: null,
    totals: { ...NONE, failed: 1 },
  });
  const asked: string[] = [];
  // Every read the board makes stays out, the project's included.
  const board = await mountBoard(url => {
    asked.push(url.replace(/\?.*$/, ''));
    return new Promise<Response>(() => undefined);
  });
  try {
    expect(board.container.querySelector('[data-item="issue-3"]')).not.toBeNull();
    expect(asked.filter(url => url.includes('/forge/'))).toEqual([]);
  } finally {
    await board.unmount();
  }
});

test('the Overview tiles and the Board count the same items: in flight, merged and the Merged column', () => {
  const now = new Date();
  const hoursAgo = (hours: number): string =>
    new Date(now.getTime() - hours * 3600_000).toISOString();
  // Merged an hour ago, three days ago and thirty days ago (outside the Merged column), each
  // `took` hours after its run started.
  const merged = (key: string, ago: number, took: number): ItemRead => ({
    ...item(key, 'check', 'done'),
    runs: item(key, 'check', 'done').runs.map(run => ({ ...run, startedAt: hoursAgo(ago + took) })),
    merged: {
      change: `https://example.test/pull/${key}`,
      commit: null,
      at: hoursAgo(ago),
      recordedAt: now.toISOString(),
      via: 'cli',
      fromRun: null,
    },
  });
  const dropped = item('issue-6', 'check', 'done');
  const reads = [
    item('issue-1', 'plan', 'running'),
    item('issue-2', 'check', 'queued'),
    merged('issue-3', 1, 1),
    merged('issue-4', 72, 2),
    merged('issue-5', 720, 4),
    // Ended without merging: set aside, on neither page's count.
    { ...dropped, runs: dropped.runs.map(run => ({ ...run, outcome: 'dropped' })) },
  ];
  seedBoard(reads);
  // The stage-only read holds the moving items alone, as the server answers it.
  set(K.board('web'), reads.slice(0, 2));
  set(K.packGraph('web', 'flow'), graph);
  // The pack ships no curated view file, so the Overview draws the derived flow it counts in.
  set(K.packView('web', 'flow'), { path: null, view: null, problems: [] });
  const board = render('/console/p/web/board', <BoardPage />);
  const overview = render('/console/p/web', <OverviewPage />);
  const tile = (name: string): string | null | undefined =>
    overview.querySelector(`[data-number="${name}"] [data-value]`)?.textContent;
  const onStages = board.querySelectorAll('[data-pack="flow"] [data-stage] [data-item]').length;
  const mergedShown = board.querySelector('[data-merged] [data-count]')?.textContent;
  expect(tile('in-flight')).toBe(String(onStages));
  expect(onStages).toBe(2);
  expect(overview.querySelector('[data-flow-group="merged"] [data-count]')?.textContent).toBe(
    mergedShown
  );
  expect(mergedShown).toBe('2');
  // N of M: three merged of the five on the board (two moving, three merged).
  expect(tile('merged')).toBe('3 of 5');
  // The median of 1 h, 2 h and 4 h from first run to merge.
  expect(tile('median-to-merged')).toBe('2 h');
  expect(board.querySelector('[data-set-aside-count]')?.textContent).toBe('1');
  // The Table lists what the Pipeline shows (two on stages, two merged this week), no columns.
  const table = render('/console/p/web/board?view=table', <BoardPage />);
  expect(table.querySelectorAll('[data-row]').length).toBe(4);
  expect(table.querySelector('[data-stage]')).toBeNull();
});
