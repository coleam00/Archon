import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { BoardPage, PackBoard } from './BoardPage';
import { ColumnHeader } from '../factory/ColumnHeader';
import { CardsContext } from '../factory/cards-context';
import type { AskRead } from '../factory/lib/item-asks';
import { NO_ITEM_ASKS } from '../components/ItemAsksSection';
import { OverviewPage } from './OverviewPage';
import { packBoard } from '../factory/lib/board-numbers';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import type { Project } from '../primitives/project';
import type { ItemAsk } from '../primitives/run';
import type { FactoryView } from '../factory/api';
import { shippedFile, shippedGraph } from '../factory/curated.test-fixtures';
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
        changeSize: null,
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
    ended: null,
    workOrder: null,
    dependsOn: [],
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
    observes: false,
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
  set(K.boardOrders('web'), [
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
    // A stage the pack no longer has and a run of no pack: on no column (set aside, below).
    item('issue-4', 'retired', 'queued'),
    item('issue-5', null, 'running'),
    // A failed item, which stands on no column: the decision strip shows it.
    item('issue-3', 'check', 'failed'),
  ]);
  set(K.packGraph('web', 'flow'), graph);
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
    // `lint`, which only other workflows call, is no stage. The failed item is on none, and
    // there is no column for an item at no stage.
    ['plan', ['issue-2']],
    ['build', []],
    ['check', ['issue-1']],
  ]);
  expect(page.querySelector('[data-stage="Not on a stage"]')).toBeNull();
  expect(keysIn(pack)).not.toContain('issue-4');
  // Every column is the same width, the empty `build` too.
  const widths = new Set(
    [...pack.querySelectorAll('[data-stage]')].map(stage => stage.getAttribute('class'))
  );
  expect(widths.size).toBe(1);
  expect([...widths][0]).toContain('md:flex-1');
  expect([...widths][0]).not.toContain('md:w-28');
  // The pack's Setup and Settings pages are not linked from the board.
  expect(page.querySelector('[data-pack-links]')).toBeNull();
  const hrefs = [...page.querySelectorAll('a')].map(link => link.getAttribute('href') ?? '');
  expect(hrefs.filter(href => /\/(setup|settings)$/.test(href))).toEqual([]);
  const decide = page.querySelector('[data-needs-decision]');
  expect(decide === null ? [] : keysIn(decide)).toEqual(['issue-3']);
  expect(decide?.querySelector('[data-item-reason]')?.textContent).toContain('check');
  expect(keysIn(page)).not.toContain('issue-5');

  // An item shows its title, links to its run, and says how it stands.
  const card = page.querySelector('[data-item="issue-3"]');
  expect(card?.getAttribute('data-state')).toBe('failed');
  expect(card?.querySelector('[data-item-title]')?.textContent).toBe('Title of issue-3');
  expect(card?.querySelector('a')?.getAttribute('href')).toBe('/console/p/web/r/run-issue-3');
  // The card's chip is its state, a label; that it waits on the operator is its button.
  expect(page.querySelector('[data-item="issue-2"] [data-chip]')?.textContent).toBe('Waiting');
  // The Board has no Needs you section (that is its own tab); the item that has an ask links to
  // that tab, filtered to it, from one button in its card's actions.
  expect(page.querySelector('[data-needs-you]')).toBeNull();
  const links = page.querySelectorAll(
    '[data-item="issue-2"] [data-card-actions] [data-needs-you-link]'
  );
  expect(links.length).toBe(1);
  expect(links[0]?.textContent).toBe('Needs you · 1');
  expect(links[0]?.getAttribute('href')).toBe('/console/p/web/needs-you?item=issue-2');
});

/** One open attention ask on the item `key`. */
const askOn = (key: string): ItemAsk => ({
  ...ask,
  ref: `ask:${key}`,
  item: { id: `id-${key}`, projectKey: 'acme/web', key },
});

test("a column header's chips count its cards: needs you by their buttons, the rest by their labels (#243)", () => {
  // A waiting item with an open ask, a waiting one whose read holds a question but no ask (the
  // old rule counted it as needs you), and a running one with an open ask.
  const reads = [
    item('issue-a', 'build', 'waiting'),
    { ...item('issue-b', 'build', 'waiting'), questions: [ask] } as unknown as ItemRead,
    item('issue-c', 'build', 'running'),
  ];
  seedBoard(reads);
  set(K.packGraph('web', 'flow'), graph);
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    // issue-a holds two asks: the header counts cards with a button (2), not asks (3).
    asks: [askOn('issue-a'), { ...askOn('issue-a'), ref: 'ask:issue-a-2' }, askOn('issue-c')],
    answerRefusals: {},
    itemIds: new Set(['id-issue-a', 'id-issue-c']),
    degraded: [],
  });

  const page = render('/console/p/web/board', <BoardPage />);
  const column = page.querySelector('[data-pack="flow"] [data-stage="build"]');
  if (column === null) throw new Error('Expected the build column');
  expect(keysIn(column)).toEqual(['issue-a', 'issue-b', 'issue-c']);
  const header = Object.fromEntries(
    [...column.querySelectorAll('[data-header-chip]')].map(chip => [
      chip.getAttribute('data-header-chip'),
      Number(chip.textContent?.replace(/\D+/g, '')),
    ])
  );
  // What the cards show, counted from their own markup.
  const buttons = column.querySelectorAll('[data-needs-you-link]').length;
  const labels = [...column.querySelectorAll('[data-chip]')].map(chip =>
    chip.getAttribute('data-chip')
  );
  const labelled = (state: string): number => labels.filter(label => label === state).length;
  expect(buttons).toBe(2);
  expect(header).toEqual({
    needs_you: buttons,
    running: labelled('running'),
    waiting: labelled('waiting'),
  });
  expect(header).toEqual({ needs_you: 2, running: 1, waiting: 2 });
  expect(column.querySelector('[data-chip-reading]')).toBeNull();
});

test('a column header waits for the asks: a skeleton while they are read, no needs-you chip if they failed', () => {
  const reads = [item('issue-a', 'build', 'waiting'), item('issue-c', 'build', 'running')];
  const header = (itemAsks: AskRead | null): Document => {
    const html = renderToStaticMarkup(
      itemAsks === null ? (
        <ColumnHeader label="Build" subtitle="build" items={reads} />
      ) : (
        <CardsContext.Provider
          value={{ projectId: 'web', packs: null, packsError: false, itemAsks }}
        >
          <ColumnHeader label="Build" subtitle="build" items={reads} />
        </CardsContext.Provider>
      )
    );
    const dom = new Window();
    dom.document.body.innerHTML = html;
    return dom.document as unknown as Document;
  };
  const chips = (doc: Document): (string | null)[] =>
    [...doc.querySelectorAll('[data-header-chip]')].map(chip =>
      chip.getAttribute('data-header-chip')
    );
  // The states are known, so their chips are drawn; only the needs-you count waits.
  const reading = header('reading');
  expect(reading.querySelector('[data-chip-reading]')).not.toBeNull();
  expect(chips(reading)).toEqual(['running', 'waiting']);
  // A failed read gives no card a button, so the header counts none either.
  const failed = header('failed');
  expect(failed.querySelector('[data-chip-reading]')).toBeNull();
  expect(chips(failed)).toEqual(['running', 'waiting']);
  // A pack board drawn with no provider is given no asks: no chip and no lasting skeleton.
  const alone = header(null);
  expect(alone.querySelector('[data-chip-reading]')).toBeNull();
  expect(chips(alone)).toEqual(['running', 'waiting']);
  // Asks read, none open on the column: no "needs you 0" (rule 9: only counts above 0).
  const none = header(NO_ITEM_ASKS);
  expect(none.querySelector('[data-chip-reading]')).toBeNull();
  expect(chips(none)).toEqual(['running', 'waiting']);
});

test('the board page hands its headers the asks as unread until the attention list answers', () => {
  seedBoard([item('issue-a', 'build', 'waiting')]);
  set(K.packGraph('web', 'flow'), graph);
  // The attention list has not answered: the header waits rather than guessing 0.
  invalidate(K.runsAttention);
  const page = render('/console/p/web/board', <BoardPage />);
  const column = page.querySelector('[data-pack="flow"] [data-stage="build"]');
  expect(column?.querySelector('[data-chip-reading]')).not.toBeNull();
  expect(column?.querySelector('[data-header-chip="needs_you"]')).toBeNull();
  // Still read, not failed: nothing says the asks could not be read.
  expect(page.querySelector('[data-asks-unread]')).toBeNull();
  // The tab row's Needs you count waits too: no badge, neither a number nor "?" (#263).
  expect(page.querySelector('[data-needs-count]')).toBeNull();
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
  set(K.packGraph('web', 'flow'), graph);
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
  expect(page.querySelector('[data-set-aside]')).toBeNull();
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

/** A pack board drawn with the pack's view file, as the board's cards read it. */
function renderWithView(packGraph: PackGraph, view: FactoryView | null, reads: ItemRead[]) {
  set(K.packGraph('web', 'flow'), packGraph);
  const packs = new Map([['flow', { stages: packGraph.stages, view }]]);
  return render(
    '/console/p/web/board',
    <CardsContext.Provider
      value={{ projectId: 'web', packs, packsError: false, itemAsks: NO_ITEM_ASKS }}
    >
      <PackBoard projectId="web" pack="flow" board={packBoard(reads, 'flow', new Date())} counted />
    </CardsContext.Provider>
  );
}

test("a column header names its stages in the view file's words, and an ungrouped stage's column by its label", () => {
  // The shipped file, with `stage-host` taken out of every group so it heads a column alone.
  const view: FactoryView = {
    ...shippedFile,
    groups: (shippedFile.groups ?? []).map(group => ({
      ...group,
      stages: group.stages.filter(stage => stage !== 'stage-host'),
    })),
  };
  const page = renderWithView({ ...shippedGraph, pack: 'flow' }, view, [
    item('issue-1', 'stage-build', 'running'),
    item('issue-2', 'stage-host', 'running'),
  ]);
  const built = page.querySelector('[data-stage="Plan and build"] header p');
  expect(built?.textContent).toBe('Plan, Build, Attend');
  expect(built?.getAttribute('title')).toBe('plan, stage-build, attend');
  const host = page.querySelector('[data-stage="stage-host"] h3');
  expect(host?.textContent).toBe('CI and review');
  expect(host?.getAttribute('title')).toBe('stage-host');
});

test("with no view file, a stage's column is headed by its id in words", () => {
  const stages = graph.stages.map(stage =>
    stage.workflow === 'build' ? { ...stage, workflow: 'stage-build' } : stage
  );
  const page = renderWithView({ ...graph, stages }, null, [
    item('issue-1', 'stage-build', 'running'),
  ]);
  const column = page.querySelector('[data-stage="stage-build"]');
  expect(column?.querySelector('h3')?.textContent).toBe('Stage build');
  expect(column?.querySelector('header p')?.textContent).toBe('Stage build');
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

test("the Needs you tab counts the project's open asks, not another project's (#263)", () => {
  set(K.projects, [project('web', ['flow'])]);
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [
      askOn('issue-a'),
      askOn('issue-b'),
      { ...askOn('issue-c'), project: { key: 'acme/docs', codebaseId: 'docs', name: 'docs' } },
    ],
    answerRefusals: {},
    itemIds: new Set(),
    degraded: [],
  });
  const page = render('/console/p/web', <ProjectViewTabs projectId="web" active="runs" />);
  expect(page.querySelector('a[href$="/needs-you"] [data-needs-count]')?.textContent).toBe('2');
});

const untitled = (key: string, stage: string): ItemRead => {
  const read = item(key, stage, 'waiting');
  return { ...read, item: { ...read.item, title: null } };
};

/** What a mounted board reads apart from its pack graph and view, seeded so nothing is fetched. */
function seedBoard(reads: ItemRead[]): void {
  set(K.projects, [project('web', ['flow'])]);
  set(K.boardOrders('web'), reads);
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
async function mountBoard(
  answer: (url: string) => Promise<Response>,
  path = '/console/p/web/board'
) {
  const dom = new Window({ url: 'http://localhost' });
  // The columns brought into view (`?group=`), by their `data-stage`.
  const scrolled: (string | null)[] = [];
  dom.HTMLElement.prototype.scrollIntoView = function (this: Element): void {
    scrolled.push(this.getAttribute('data-stage'));
  };
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
      <MemoryRouter initialEntries={[path]}>
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
    scrolled,
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

test("the decision strip shows the every-item read's failed and stopped items in its order, six at a time", async () => {
  // Newest first, as the server orders every read; open and done items between them.
  const reads = [
    ...[1, 2, 3, 4].map(n =>
      item(`issue-${String(n)}`, 'check', n % 2 === 0 ? 'stopped' : 'failed')
    ),
    item('issue-20', 'plan', 'running'),
    ...[5, 6, 7, 8].map(n => item(`issue-${String(n)}`, 'check', 'failed')),
    item('issue-21', 'check', 'done'),
  ];
  seedBoard(reads);
  set(K.packGraph('web', 'flow'), graph);
  // Showing more reads nothing: every fetch fails the test's expectations below.
  const board = await mountBoard(nothingFetched);
  try {
    const strip = () => board.container.querySelector('[data-needs-decision]');
    expect(strip()?.querySelector('[data-decide-total]')?.textContent).toBe('8');
    expect(keysIn(strip() as unknown as ParentNode)).toEqual([
      'issue-1',
      'issue-2',
      'issue-3',
      'issue-4',
      'issue-5',
      'issue-6',
    ]);
    const more = [...(strip()?.querySelectorAll('button') ?? [])].find(button =>
      button.textContent?.startsWith('Show more')
    );
    expect(more?.textContent).toBe('Show more of 8');
    await board.act(async () => {
      (more as unknown as HTMLElement).click();
    });
    expect(keysIn(strip() as unknown as ParentNode)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map(n => `issue-${String(n)}`)
    );
    const fewer = [...(strip()?.querySelectorAll('button') ?? [])].find(
      button => button.textContent === 'Show fewer'
    );
    await board.act(async () => {
      (fewer as unknown as HTMLElement).click();
    });
    expect(keysIn(strip() as unknown as ParentNode)).toHaveLength(6);
  } finally {
    await board.unmount();
  }
});

/** An item standing on its only run, of the retired `deliver`, which recorded no pack workflow. */
function delivered(key: string): ItemRead {
  const read = item(key, null, 'waiting');
  return {
    ...read,
    standing: { ...read.standing, pack: 'flow' },
    runs: read.runs.map(run => ({ ...run, workflow: 'acme/flow:deliver' })),
  };
}

/** The board mounted with its pack's graph and a view that retires `deliver` as `retired`. */
async function mountPlaced(reads: ItemRead[], retired: unknown[]) {
  seedBoard(reads);
  set(K.packGraph('web', 'flow'), graph);
  set(K.packView('web', 'flow'), {
    path: null,
    view: { retired, stages: {} } as unknown as FactoryView,
    problems: [],
  });
  const board = await mountBoard(nothingFetched);
  const columns = (): string[][] =>
    [...board.container.querySelectorAll('[data-pack="flow"] [data-stage]')].map(stage => [
      stage.getAttribute('data-stage') ?? '',
      ...keysIn(stage as unknown as ParentNode),
    ]);
  const setAside = async (): Promise<string[][]> => {
    const toggle = board.container.querySelector('[data-set-aside] button');
    if (toggle !== null && toggle.getAttribute('aria-expanded') !== 'true')
      await board.act(async () => {
        (toggle as unknown as HTMLElement).click();
      });
    return [...board.container.querySelectorAll('[data-set-aside] [data-item]')].map(row => [
      row.getAttribute('data-item') ?? '',
      row.querySelector('[data-set-aside-why]')?.textContent ?? '',
    ]);
  };
  return { ...board, columns, setAside };
}

test("a pack whose graph has no groups takes its board columns from the view file's groups", async () => {
  seedBoard([item('issue-1', 'plan', 'running'), item('issue-2', 'check', 'queued')]);
  set(K.packGraph('web', 'flow'), graph);
  set(K.packView('web', 'flow'), {
    path: null,
    view: {
      groups: [{ name: 'Make', blurb: 'x', stages: ['plan', 'build'], kind: 'build' }],
      stages: {},
    } as unknown as FactoryView,
    problems: [],
  });
  const board = await mountBoard(nothingFetched);
  try {
    expect(graph.groups).toEqual([]);
    expect(
      [...board.container.querySelectorAll('[data-pack="flow"] [data-stage]')].map(stage => [
        stage.getAttribute('data-stage') ?? '',
        ...keysIn(stage as unknown as ParentNode),
      ])
    ).toEqual([
      ['Make', 'issue-1'],
      ['check', 'issue-2'],
    ]);
  } finally {
    await board.unmount();
  }
});

test("a map link's ?group= brings an ungrouped stage's column into view by its id, not its heading", async () => {
  const stages = graph.stages.map(stage =>
    stage.workflow === 'build' ? { ...stage, workflow: 'stage-build' } : stage
  );
  seedBoard([item('issue-1', 'stage-build', 'running')]);
  set(K.packGraph('web', 'flow'), { ...graph, stages });
  set(K.packView('web', 'flow'), {
    path: null,
    view: { stages: {} } as unknown as FactoryView,
    problems: [],
  });
  const board = await mountBoard(nothingFetched, '/console/p/web/board?group=stage-build');
  try {
    const column = board.container.querySelector('[data-stage="stage-build"]');
    // The heading is the stage's words, so only the id can find it.
    expect(column?.querySelector('h3')?.textContent).toBe('Stage build');
    expect(board.scrolled).toEqual(['stage-build']);
  } finally {
    await board.unmount();
  }
});

test('an item on a retired workflow stands at the stage the view maps it to', async () => {
  const board = await mountPlaced(
    [item('issue-1', 'plan', 'running'), delivered('issue-6')],
    [{ workflow: 'deliver', stage: 'build' }]
  );
  try {
    expect(board.columns()).toEqual([['plan', 'issue-1'], ['build', 'issue-6'], ['check']]);
    expect(await board.setAside()).toEqual([]);
  } finally {
    await board.unmount();
  }
});

test('an open item at no stage is set aside with the reason, never in a column', async () => {
  const board = await mountPlaced(
    [
      item('issue-1', 'plan', 'running'),
      // Retired with no stage to place at.
      delivered('issue-6'),
      // A workflow the pack no longer has and the view does not retire.
      item('issue-4', 'gone', 'queued'),
      // A run of no pack.
      item('issue-5', null, 'running'),
    ],
    ['deliver']
  );
  try {
    expect(board.columns()).toEqual([['plan', 'issue-1'], ['build'], ['check']]);
    expect(board.container.querySelector('[data-stage="Not on a stage"]')).toBeNull();
    expect((await board.setAside()).sort()).toEqual([
      ['issue-4', 'On no stage'],
      ['issue-5', "On no pack's stage"],
      ['issue-6', 'On no stage'],
    ]);
    // The header counts what the stages hold.
    expect(board.container.querySelector('[role="status"]')?.textContent).toBe('1 on a stage');
  } finally {
    await board.unmount();
  }
});

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

test('the graph, the view and the titles are asked for at once; the columns draw when the graph answers', async () => {
  // Untitled issue-keyed items, whose cards ask the forge for their titles: one in a column,
  // and one in the decision strip.
  const failed = item('issue-3', 'check', 'failed');
  seedBoard([untitled('issue-2', 'plan'), { ...failed, item: { ...failed.item, title: null } }]);
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
    // While the graph read is out, nothing waits on it: the server answers the view from the
    // same graph read, and the strip's card asks for its title, which needs only its item read.
    expect([...asked].sort()).toEqual([
      '/api/forge/subjects',
      '/api/packs/flow/graph',
      '/api/packs/flow/view',
    ]);
    expect(board.container.querySelectorAll('[data-stage]').length).toBe(0);
    await board.act(async () => {
      answerGraph();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    // The columns draw, and the column's card asks for its title.
    expect(board.container.querySelectorAll('[data-stage]').length).toBeGreaterThan(0);
    expect(asked.slice(3)).toEqual(['/api/forge/subjects']);
  } finally {
    await board.unmount();
  }
});

test('while the project is still read, cards ask the forge for titles but read no run records', async () => {
  const failed = item('issue-3', 'check', 'failed');
  seedBoard([{ ...failed, item: { ...failed.item, title: null } }]);
  invalidate('projects');
  const asked: string[] = [];
  // Every read the board makes stays out, the project's included.
  const board = await mountBoard(url => {
    asked.push(url.replace(/\?.*$/, ''));
    return new Promise<Response>(() => undefined);
  });
  try {
    expect(board.container.querySelector('[data-item="issue-3"]')).not.toBeNull();
    expect(asked.filter(url => url.includes('/forge/'))).not.toEqual([]);
    // Which runs a card reads comes from its pack, which is unknown until the project is read.
    expect(asked.filter(url => url.includes('/runs/records'))).toEqual([]);
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
  // Both pages say how many are on a stage from the one every-item read: the moving items only,
  // not the merged or dropped ones beside them.
  expect(overview.querySelector('[role="status"]')?.textContent).toBe('2 on a stage');
  expect(board.querySelector('[role="status"]')?.textContent).toBe('2 on a stage');
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

/** Fails the attention read with a server error; every other read as `nothingFetched`. */
const attentionDown = (url: string): Promise<Response> =>
  url.includes('/api/runs/attention')
    ? Promise.resolve(
        new Response(JSON.stringify({ error: 'attention store unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    : nothingFetched(url);

test('a board whose asks could not be read says so once, and claims no needs-you anywhere (#258)', async () => {
  seedBoard([item('issue-1', 'build', 'waiting'), item('issue-2', 'build', 'running')]);
  set(K.packGraph('web', 'flow'), graph);
  // Never read: the board's read is the first, and it fails.
  invalidate(K.runsAttention);
  const board = await mountBoard(attentionDown);
  try {
    await board.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    const page = board.container;
    const alerts = page.querySelectorAll('[data-asks-unread]');
    expect(alerts.length).toBe(1);
    const alert = alerts[0]?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('attention store unavailable');
    expect(
      [...(alert?.querySelectorAll('button') ?? [])].map(button => button.textContent)
    ).toEqual(['Retry']);
    // No count claims none, and none claims it is still being read.
    expect(page.querySelector('[data-header-chip="needs_you"]')).toBeNull();
    expect(page.querySelector('[data-needs-you-link]')).toBeNull();
    expect(page.querySelector('[data-chip-reading]')).toBeNull();
    // The tab row's Needs you count is unknown, and says why, rather than drawing as none (#263).
    const tabCount = page.querySelector('a[href$="/needs-you"] [data-needs-count]');
    expect(tabCount?.textContent).toBe('?');
    expect(tabCount?.getAttribute('title')).toContain('attention store unavailable');
    // What was drawn stays drawn: the column, its cards and their other chips.
    const column = page.querySelector('[data-pack="flow"] [data-stage="build"]');
    if (column === null) throw new Error('Expected the build column');
    expect(keysIn(column as unknown as ParentNode)).toEqual(['issue-1', 'issue-2']);
    expect(
      [...column.querySelectorAll('[data-header-chip]')].map(chip =>
        chip.getAttribute('data-header-chip')
      )
    ).toEqual(['running', 'waiting']);
  } finally {
    await board.unmount();
  }
});

test('a failed re-read of the asks keeps the asks read before, with no alert (#258)', async () => {
  seedBoard([item('issue-2', 'build', 'waiting')]);
  set(K.packGraph('web', 'flow'), graph);
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [askOn('issue-2')],
    answerRefusals: {},
    itemIds: new Set(['id-issue-2']),
    degraded: [],
  });
  const board = await mountBoard(attentionDown);
  try {
    // The attention list is read again, and that read fails.
    await board.act(async () => {
      invalidate(K.runsAttention);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    const page = board.container;
    expect(page.querySelector('[data-asks-unread]')).toBeNull();
    expect(page.querySelector('[data-item="issue-2"] [data-needs-you-link]')).not.toBeNull();
    expect(page.querySelector('[data-header-chip="needs_you"]')).not.toBeNull();
    // The tab row keeps the count read before (#263).
    expect(page.querySelector('a[href$="/needs-you"] [data-needs-count]')?.textContent).toBe('1');
  } finally {
    await board.unmount();
  }
});
