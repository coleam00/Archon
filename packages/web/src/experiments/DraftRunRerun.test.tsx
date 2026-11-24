import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { invalidate, set } from './console/store/cache';
import { K } from './console/store/keys';
import { toRun } from './console/primitives/run';
import { toWorkflow } from './console/primitives/workflow';
import { rerunPath } from './console/lib/rerun';
import { RunsPage } from './console/routes/RunsPage';

const dom = new Window({ url: 'http://localhost' });
const globals = {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  KeyboardEvent: dom.KeyboardEvent,
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
let router: ReturnType<typeof createMemoryRouter> | undefined;
const container = document.createElement('div');
const projectCwd = '/draft-rerun-test';
const originalFetch = globalThis.fetch;
let started: Record<string, unknown>[] = [];
/** Resolves when the runs feed may answer; a test that holds it sees the feed loading. */
let feedAnswers: Promise<void> = Promise.resolve();
let feedFails = false;

beforeEach(() => {
  started = [];
  feedAnswers = Promise.resolve();
  feedFails = false;
  // The project is warm, as it is when the run detail page sent the operator here; the
  // runs feed is not, so it loads after the page mounts.
  set(K.project('p1'), {
    id: 'p1',
    name: 'demo',
    path: projectCwd,
    defaultBranch: 'dev',
    repositoryUrl: null,
    lastSyncedAt: null,
    kind: 'repo',
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/dashboard/runs')) {
        await feedAnswers;
        return feedFails
          ? Response.json({ error: 'feed down' }, { status: 500 })
          : Response.json({ runs: [], counts: {}, total: 0 });
      }
      if (url.startsWith('/api/runs/attention'))
        return Response.json({ runs: [], items: [], answerRefusals: [] });
      // A test that does not `offer` workflows sees their list still loading.
      if (url.startsWith('/api/workflows?')) return new Promise<Response>(() => {});
      if (url === '/api/conversations') return Response.json({ conversationId: 'web-test' });
      if (url.endsWith('/run')) {
        started.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ accepted: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    { preconnect: originalFetch.preconnect }
  );
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  router?.dispose();
  container.remove();
  invalidate(K.workflows(projectCwd));
  invalidate(K.project('p1'));
  invalidate(K.runs('p1'));
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** The workflows the card offers now; `inputs` is each one's current declaration. */
function offer(...workflows: { name: string; inputs: Record<string, { default?: string }> }[]) {
  set(K.workflows(projectCwd), {
    workflows: workflows.map(workflow => toWorkflow({ workflow, source: 'project' })),
    recommended: [],
  });
}

function rerunLink(run: { message: string; supplied: Record<string, string> }): string {
  const original = toRun({
    id: 'run-1',
    workflow_name: 'build',
    codebase_id: 'p1',
    status: 'completed',
    started_at: '2026-11-24T10:00:00Z',
    user_message: run.message,
    supplied_inputs: run.supplied,
  });
  return rerunPath({ ...original, projectId: 'p1' });
}

/** Follow the Re-run link of a run of `build` started with `message` and `supplied`. */
async function rerun(run: { message: string; supplied: Record<string, string> }): Promise<void> {
  const memory = createMemoryRouter([{ path: '/console/p/:projectId', element: <RunsPage /> }], {
    initialEntries: [rerunLink(run)],
  });
  router = memory;
  root = createRoot(container);
  await act(async () => root?.render(<RouterProvider router={memory} />));
}

function field(name: string): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label')].find(l => l.textContent?.startsWith(name));
  return label?.querySelector('input') ?? null;
}

async function click(button: HTMLElement | null | undefined): Promise<void> {
  if (!button) throw new Error('Missing button');
  await act(async () => button.click());
}

async function pick(workflow: string): Promise<void> {
  await click(container.querySelector<HTMLElement>('[data-keymap-workflow-trigger]'));
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o =>
      o.textContent?.includes(workflow)
    )
  );
}

function startButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(b =>
    b.textContent?.startsWith('Start run')
  );
}

async function start(): Promise<Record<string, unknown> | undefined> {
  await click(startButton());
  return started[0];
}

// `a-other` sorts first, so the card's default pick competes with the re-run's workflow.
test('an inputs-only run re-runs with its supplied input filled and its defaulted one left empty', async () => {
  offer(
    { name: 'a-other', inputs: { issue: {} } },
    { name: 'build', inputs: { issue: {}, notes: { default: 'from-default' } } }
  );
  await rerun({ message: '', supplied: { issue: '42' } });

  expect(field('issue')?.value).toBe('42');
  expect(field('notes')?.value).toBe('');
  expect(router?.state.location.search).toBe('');
  const body = await start();
  expect(body?.message).toBe('');
  expect(body?.inputs).toEqual({ issue: '42' });
});

test('a re-run restores the message and drops an input the workflow no longer declares', async () => {
  offer({ name: 'build', inputs: { notes: {} } });
  await rerun({ message: 'fix the flaky test', supplied: { issue: '42', notes: 'be brief' } });

  expect(container.querySelector('textarea')?.value).toBe('fix the flaky test');
  const body = await start();
  expect(body?.message).toBe('fix the flaky test');
  expect(body?.inputs).toEqual({ notes: 'be brief' });
});

test('confirming the workflow keeps the re-run inputs; picking another discards them, also after picking back', async () => {
  offer({ name: 'a-other', inputs: { issue: {} } }, { name: 'build', inputs: { issue: {} } });
  await rerun({ message: '', supplied: { issue: '42' } });
  expect(field('issue')?.value).toBe('42');
  await pick('build');
  expect(field('issue')?.value).toBe('42');

  await pick('a-other');
  expect(field('issue')?.value).toBe('');
  await pick('build');
  expect(field('issue')?.value).toBe('');
  const body = await start();
  expect(body?.inputs).toBeUndefined();
});

test('while the feed loads, the page says so instead of counting no active runs, and keeps the re-run', async () => {
  offer({ name: 'build', inputs: { issue: {} } });
  let answer = (): void => {};
  feedAnswers = new Promise(resolve => {
    answer = resolve;
  });
  await rerun({ message: '', supplied: { issue: '42' } });

  expect(container.textContent).toContain('Loading…');
  expect(container.textContent).not.toContain('Active0');
  expect(field('issue')?.value).toBe('42');

  await act(async () => answer());
  expect(container.textContent).not.toContain('Loading…');
  expect(container.textContent).toContain('Active0');
  expect(field('issue')?.value).toBe('42');
});

test('the card does not start a re-run until it knows the workflow declares its inputs', async () => {
  await rerun({ message: '', supplied: { issue: '42' } });

  expect(startButton()?.disabled).toBe(true);
  const textarea = container.querySelector('textarea');
  await act(async () => {
    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(started).toEqual([]);
});

test('a re-run without a message replaces the message already in the card', async () => {
  offer({ name: 'build', inputs: { issue: {} } });
  await rerun({ message: 'an earlier request', supplied: {} });
  expect(container.querySelector('textarea')?.value).toBe('an earlier request');

  await act(async () => router?.navigate(rerunLink({ message: '', supplied: { issue: '42' } })));
  expect(container.querySelector('textarea')?.value).toBe('');
  const body = await start();
  expect(body?.message).toBe('');
  expect(body?.inputs).toEqual({ issue: '42' });
});

test('when the feed fails to load, the re-run card stays with its inputs beside the error', async () => {
  offer({ name: 'build', inputs: { issue: {} } });
  feedFails = true;
  await rerun({ message: '', supplied: { issue: '42' } });

  expect(container.textContent).toContain('Could not load runs.');
  expect(field('issue')?.value).toBe('42');
});
