import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { BoardPage } from './BoardPage';
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
    standing: { runId: `run-${key}`, state },
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
  groups: [],
  arrows: [],
  fanOutBlocks: [],
  discoveryErrors: [],
};

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
    item('issue-1', 'check', 'running'),
    { ...item('issue-2', 'plan', 'waiting'), questions: [ask] },
    item('issue-3', 'check', 'failed'),
    // A stage the pack no longer has stays on the board; a run of no pack waits to be asked for.
    item('issue-4', 'retired', 'queued'),
    item('issue-5', null, 'running'),
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
  // The project's asks are on the page, and the item that has one links to it.
  const asked = page.querySelector('[data-ask-ref="ask:a1"]')?.closest('[id]');
  expect(asked).not.toBeNull();
  expect(
    page.querySelector(`[data-item="issue-2"] a[href="#${asked?.getAttribute('id') ?? ''}"]`)
  ).not.toBeNull();
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
  expect(tabs('docs')).toEqual([
    '/console/p/docs',
    '/console/p/docs/chat',
    '/console/p/docs/metrics',
  ]);
});
