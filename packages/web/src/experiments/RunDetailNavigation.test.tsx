import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { set, invalidate } from './console/store/cache';
import { K } from './console/store/keys';
import { detailFixture } from './console/primitives/run.test-fixtures';
import { toRun } from './console/primitives/run';
import { toRunEvent } from './console/primitives/event';
import type { Project } from './console/primitives/project';
import type { WorkflowGraphNode } from './console/primitives/workflow-graph';
import { DETAIL_VIEWS, DETAIL_VIEW_LABELS } from './console/components/StreamToolbar';
import { RunDetailPage } from './console/routes/RunDetailPage';

const dom = new Window({ url: 'http://localhost' });
const globals = {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
let router: ReturnType<typeof createMemoryRouter>;
const container = document.createElement('div');
const base = '/console/r/run-1';
const viewKey = 'archon.console.detailView';
const nodeKey = 'archon.console.runNodeFilter';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
  set(K.run('run-1'), {
    run: toRun(detailFixture.run),
    events: [
      ...detailFixture.events.map(toRunEvent),
      toRunEvent({
        ...detailFixture.events[0],
        id: 'other-event',
        workflow_run_id: 'run-1',
        event_type: 'node_completed',
        data: {},
        created_at: '2026-10-05T10:02:00Z',
        step_name: 'other',
      }),
    ],
    nodes: [...detailFixture.run.nodes, { node_id: 'other', state: 'completed' }],
  });
  set(K.artifacts('run-1'), []);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/workflows/runs/run-1/provider-events?')) {
        return Response.json({ events: [] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    },
    { preconnect: originalFetch.preconnect }
  );
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  router.dispose();
  container.remove();
  invalidate(K.run('run-1'));
  invalidate(K.artifacts('run-1'));
  invalidate(K.project('project-1'));
  invalidate('workflow-graph');
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function open(url: string): Promise<void> {
  router = createMemoryRouter(
    [
      { path: '/before', element: <div>Previous page</div> },
      { path: '/console/r/:runId', element: <RunDetailPage /> },
    ],
    { initialEntries: ['/before', url], initialIndex: 1 }
  );
  root = createRoot(container);
  await act(async () => root?.render(<RouterProvider router={router} />));
}

function activeTab(label: string): void {
  const button = [...container.querySelectorAll('button')].find(b =>
    b.textContent?.startsWith(label)
  );
  expect(button?.getAttribute('aria-pressed')).toBe('true');
}

async function tab(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(b =>
    b.textContent?.startsWith(label)
  );
  if (!button) throw new Error(`Missing tab ${label}`);
  await act(async () => button.click());
}

function query(): URLSearchParams {
  return new URLSearchParams(router.state.location.search);
}

test('tab and node changes push history; Back and Forward restore the URL selection', async () => {
  await open(`${base}?view=log&node=all&keep=yes`);
  await tab('Graph');
  expect(query().get('view')).toBe('graph');
  activeTab('Graph');
  await tab('Artifacts');
  expect(query().get('view')).toBe('artifacts');
  expect(container.textContent).toContain('No artifacts written');
  await act(async () => router.navigate(-1));
  activeTab('Graph');
  await act(async () => router.navigate(-1));
  activeTab('Log');
  const select = container.querySelector('select');
  if (!select) throw new Error('Missing node filter');
  await act(async () => {
    select.value = 'outcome';
    const event = document.createEvent('Event');
    event.initEvent('change', true, true);
    select.dispatchEvent(event);
  });
  expect(query().get('node')).toBe('outcome');
  expect(container.querySelector('#node-transition-other')).toBeNull();
  expect(container.querySelector('#node-transition-outcome')).not.toBeNull();
  expect(query().get('keep')).toBe('yes');
  expect(localStorage.getItem(nodeKey)).toBe('outcome');
  await act(async () => router.navigate(-1));
  expect(container.querySelector('select')?.value).toBe('');
  expect(container.querySelector('#node-transition-other')).not.toBeNull();
  await act(async () => router.navigate(1));
  expect(container.querySelector('select')?.value).toBe('outcome');
});

test('bare links restore Artifacts and normalize with replace, leaving no extra Back entry', async () => {
  localStorage.setItem(viewKey, 'artifacts');
  localStorage.setItem(nodeKey, 'outcome');
  await open(base);
  activeTab('Artifacts');
  expect(query().get('view')).toBe('artifacts');
  expect(query().get('node')).toBe('outcome');
  await act(async () => router.navigate(-1));
  expect(container.textContent).toBe('Previous page');
});

test.each([...DETAIL_VIEWS])(
  'a shared %s link overrides stored defaults and survives remount',
  async view => {
    localStorage.setItem(viewKey, view === 'log' ? 'graph' : 'log');
    localStorage.setItem(nodeKey, 'all');
    await open(`${base}?view=${view}&node=outcome`);
    activeTab(DETAIL_VIEW_LABELS[view]);
    expect(query().get('node')).toBe('outcome');
    await tab('Log');
    expect(container.querySelector('select')?.value).toBe('outcome');
    await tab('Artifacts');
    const url = router.state.location.pathname + router.state.location.search;
    await act(async () => root?.unmount());
    router.dispose();
    await open(url);
    activeTab('Artifacts');
  }
);

test('an obsolete stored node is reset in the URL without adding history', async () => {
  localStorage.setItem(nodeKey, 'another-workflow');
  await open(base);
  expect(query().get('node')).toBe('all');
  expect(container.querySelector('select')?.value).toBe('');
  await act(async () => router.navigate(-1));
  expect(container.textContent).toBe('Previous page');
});

test('keyboard tabs use the same history as toolbar tabs; reselecting the active tab adds no entry', async () => {
  await open(`${base}?view=log&node=all`);
  await act(async () => {
    dom.dispatchEvent(new dom.KeyboardEvent('keydown', { key: '2', bubbles: true }));
  });
  activeTab('Graph');
  expect(query().get('view')).toBe('graph');
  await tab('Graph');
  await act(async () => router.navigate(-1));
  activeTab('Log');
});

test('graph node clicks select Log and that node together in one history entry', async () => {
  set(K.run('run-1'), {
    run: { ...toRun(detailFixture.run), projectId: 'project-1' },
    events: detailFixture.events.map(toRunEvent),
    nodes: detailFixture.run.nodes,
  });
  set(K.project('project-1'), {
    id: 'project-1',
    name: 'Project',
    path: '/project',
    kind: 'folder',
    defaultBranch: null,
    repositoryUrl: null,
    lastSyncedAt: null,
  } satisfies Project);
  set('workflow-graph:review:/project', [
    { id: 'outcome', kind: 'prompt', dependsOn: [] },
  ] satisfies WorkflowGraphNode[]);
  await open(`${base}?view=graph&node=all`);
  const button = container.querySelector<HTMLButtonElement>('button[title^="outcome ·"]');
  if (!button) throw new Error('Missing graph node');
  await act(async () => {
    button.click();
    await new Promise<void>(resolve => dom.requestAnimationFrame(() => resolve()));
  });
  activeTab('Log');
  expect(query().get('view')).toBe('log');
  expect(query().get('node')).toBe('outcome');
  expect(container.querySelector('select')?.value).toBe('outcome');
  await act(async () => router.navigate(-1));
  activeTab('Graph');
  expect(query().get('node')).toBe('all');
});

test('a linked node survives the initial run load', async () => {
  invalidate(K.run('run-1'));
  const providerFetch = globalThis.fetch;
  let respond: ((response: Response) => void) | undefined;
  const response = new Promise<Response>(resolve => {
    respond = resolve;
  });
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/workflows/runs/run-1' ? response : providerFetch(input, init),
    { preconnect: originalFetch.preconnect }
  );
  await open(`${base}?view=log&node=outcome`);
  expect(container.textContent).toBe('Loading run…');
  expect(query().get('node')).toBe('outcome');
  await act(async () => respond?.(Response.json(detailFixture)));
  expect(container.querySelector('select')?.value).toBe('outcome');
  expect(query().get('node')).toBe('outcome');
});

test('selecting Artifacts remembers the default for a subsequent bare link', async () => {
  await open(`${base}?view=log&node=all`);
  await tab('Artifacts');
  await act(async () => root?.unmount());
  router.dispose();
  await open(base);
  activeTab('Artifacts');
  expect(query().get('view')).toBe('artifacts');
});

function seedGraph(state: 'pending' | 'completed' | 'failed' = 'pending'): void {
  set(K.run('run-1'), {
    run: { ...toRun(detailFixture.run), projectId: 'project-1' },
    events: detailFixture.events.map(toRunEvent),
    nodes: [...detailFixture.run.nodes, { node_id: 'verify', state }],
  });
  set(K.project('project-1'), {
    id: 'project-1',
    name: 'Project',
    path: '/project',
    kind: 'folder',
    defaultBranch: null,
    repositoryUrl: null,
    lastSyncedAt: null,
  } satisfies Project);
  set('workflow-graph:review:/project', [
    { id: 'outcome', kind: 'prompt', dependsOn: [] },
    { id: 'verify', kind: 'prompt', dependsOn: ['outcome'] },
  ] satisfies WorkflowGraphNode[]);
}

test.each(['pending', 'completed', 'failed'] as const)(
  'a shared Graph link visibly selects its %s node while retaining topology',
  async state => {
    seedGraph(state);
    await open(`${base}?view=graph&node=verify`);
    expect(query().get('node')).toBe('verify');
    expect(container.querySelector('button[title^="verify ·"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(container.querySelector('button[title^="verify ·"]')?.classList.contains('ring-2')).toBe(
      true
    );
    expect(
      container.querySelector('button[title^="outcome ·"]')?.getAttribute('aria-pressed')
    ).toBe('false');
    expect(container.querySelector('svg path')).not.toBeNull();
    await act(async () => router.navigate(`${base}?view=graph&node=all`));
    expect(container.querySelector('button[title^="verify ·"]')?.getAttribute('aria-pressed')).toBe(
      'false'
    );
  }
);

test.each(['link', 'graph click'])(
  'a pending node selected by %s survives until its stream arrives',
  async entry => {
    seedGraph();
    await open(
      `${base}?view=${entry === 'link' ? 'log' : 'graph'}&node=${entry === 'link' ? 'verify' : 'all'}`
    );
    if (entry === 'graph click') {
      const button = container.querySelector<HTMLButtonElement>('button[title^="verify ·"]');
      if (!button) throw new Error('Missing pending graph node');
      await act(async () => button.click());
    }
    activeTab('Log');
    expect(query().get('node')).toBe('verify');
    expect(container.querySelector('select')?.value).toBe('verify');
    expect(container.querySelector('#node-transition-outcome')).toBeNull();
    await act(async () => {
      set(K.run('run-1'), {
        run: { ...toRun(detailFixture.run), projectId: 'project-1' },
        events: [
          ...detailFixture.events.map(toRunEvent),
          toRunEvent({
            ...detailFixture.events[0],
            id: 'verify-event',
            step_name: 'verify',
          }),
        ],
        nodes: [...detailFixture.run.nodes, { node_id: 'verify', state: 'completed' }],
      });
    });
    expect(query().get('node')).toBe('verify');
    expect(container.querySelector('#node-transition-verify')).not.toBeNull();
    expect(container.querySelector('#node-transition-outcome')).toBeNull();
  }
);

test('an obsolete stored node is validated after a delayed run load', async () => {
  localStorage.setItem(nodeKey, 'another-workflow');
  invalidate(K.run('run-1'));
  const providerFetch = globalThis.fetch;
  let respond: ((response: Response) => void) | undefined;
  const response = new Promise<Response>(resolve => {
    respond = resolve;
  });
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/workflows/runs/run-1' ? response : providerFetch(input, init),
    { preconnect: originalFetch.preconnect }
  );
  await open(base);
  expect(container.textContent).toBe('Loading run…');
  expect(query().has('node')).toBe(false);
  await act(async () => respond?.(Response.json(detailFixture)));
  expect(query().get('node')).toBe('all');
  expect(localStorage.getItem(nodeKey)).toBe('all');
  await act(async () => router.navigate(-1));
  expect(container.textContent).toBe('Previous page');
});

test('the node named all is distinct from all nodes across graph, log, history and preferences', async () => {
  seedGraph();
  set('workflow-graph:review:/project', [
    { id: 'all', kind: 'prompt', dependsOn: [] },
    { id: 'outcome', kind: 'prompt', dependsOn: ['all'] },
  ] satisfies WorkflowGraphNode[]);
  set(K.run('run-1'), {
    run: { ...toRun(detailFixture.run), projectId: 'project-1' },
    events: [
      ...detailFixture.events.map(toRunEvent),
      toRunEvent({ ...detailFixture.events[0], id: 'all-event', step_name: 'all' }),
    ],
    nodes: [...detailFixture.run.nodes, { node_id: 'all', state: 'completed' }],
  });
  await open(`${base}?view=graph&node=all`);
  const graphNode = () => container.querySelector<HTMLButtonElement>('button[title^="all ·"]');
  expect(graphNode()?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => graphNode()?.click());
  activeTab('Log');
  expect(query().get('node')).toBe('all');
  expect(query().get('nodeScope')).toBe('single');
  expect(container.querySelector('#node-transition-all')).not.toBeNull();
  expect(container.querySelector('#node-transition-outcome')).toBeNull();
  const select = container.querySelector('select');
  if (!select) throw new Error('Missing node filter');
  expect([...select.options].map(o => o.value)).toEqual(['', 'outcome', 'all']);
  expect(select.value).toBe('all');
  await tab('Graph');
  expect(graphNode()?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => router.navigate(-1));
  activeTab('Log');
  await act(async () => router.navigate(-1));
  expect(graphNode()?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => router.navigate(1));
  activeTab('Log');
  expect(container.querySelector('#node-transition-outcome')).toBeNull();
  await act(async () => root?.unmount());
  router.dispose();
  await open(base);
  expect(query().get('nodeScope')).toBe('single');
  expect(container.querySelector('select')?.value).toBe('all');
  const restored = container.querySelector('select');
  if (!restored) throw new Error('Missing restored filter');
  await act(async () => {
    restored.value = '';
    const event = document.createEvent('Event');
    event.initEvent('change', true, true);
    restored.dispatchEvent(event);
  });
  expect(query().has('nodeScope')).toBe(false);
  expect(container.querySelector('#node-transition-outcome')).not.toBeNull();
  await act(async () => {
    restored.value = 'all';
    const event = document.createEvent('Event');
    event.initEvent('change', true, true);
    restored.dispatchEvent(event);
  });
  expect(query().get('nodeScope')).toBe('single');
  expect(container.querySelector('#node-transition-outcome')).toBeNull();
  await act(async () => root?.unmount());
  router.dispose();
  await open(`${base}?view=graph&node=all&nodeScope=single`);
  expect(graphNode()?.getAttribute('aria-pressed')).toBe('true');
  await tab('Log');
  expect(container.querySelector('#node-transition-all')).not.toBeNull();
  expect(container.querySelector('#node-transition-outcome')).toBeNull();
});
