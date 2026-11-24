import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { invalidate, set } from './console/store/cache';
import { K } from './console/store/keys';
import { toRun } from './console/primitives/run';
import { toWorkflow } from './console/primitives/workflow';
import { rerunPath } from './console/lib/rerun';
import { DraftRunCard } from './console/components/DraftRunCard';

const dom = new Window({ url: 'http://localhost' });
const globals = {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
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

beforeEach(() => {
  started = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/conversations') return Response.json({ conversationId: 'web-test' });
      started.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ accepted: true });
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

/** Re-run a run that started with `inputs` resolved and `supplied` named as supplied. */
async function rerun(run: {
  message: string;
  inputs: Record<string, string>;
  supplied: string[];
}): Promise<void> {
  const original = toRun({
    id: 'run-1',
    workflow_name: 'build',
    codebase_id: 'p1',
    status: 'completed',
    started_at: '2026-11-24T10:00:00Z',
    user_message: run.message,
    metadata: {
      inputs: run.inputs,
      dispatch: { base_branch: 'dev', supplied_inputs: run.supplied },
    },
  });
  const memory = createMemoryRouter(
    [
      {
        path: '/console/p/:projectId',
        element: <DraftRunCard projectId="p1" projectCwd={projectCwd} />,
      },
    ],
    { initialEntries: [rerunPath({ ...original, projectId: 'p1' })] }
  );
  router = memory;
  root = createRoot(container);
  await act(async () => root?.render(<RouterProvider router={memory} />));
}

function field(name: string): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label')].find(l => l.textContent?.startsWith(name));
  return label?.querySelector('input') ?? null;
}

async function start(): Promise<Record<string, unknown> | undefined> {
  const button = [...container.querySelectorAll('button')].find(b =>
    b.textContent?.startsWith('Start run')
  );
  if (!button) throw new Error('Missing Start run');
  await act(async () => button.click());
  return started[0];
}

// `a-other` sorts first, so the card's default pick competes with the re-run's workflow.
test('an inputs-only run re-runs with its supplied input filled and its defaulted one left empty', async () => {
  offer(
    { name: 'a-other', inputs: { issue: {} } },
    { name: 'build', inputs: { issue: {}, notes: { default: 'from-default' } } }
  );
  await rerun({ message: '', inputs: { issue: '42', notes: 'from-default' }, supplied: ['issue'] });

  expect(field('issue')?.value).toBe('42');
  expect(field('notes')?.value).toBe('');
  expect(router?.state.location.search).toBe('');
  const body = await start();
  expect(body?.message).toBe('');
  expect(body?.inputs).toEqual({ issue: '42' });
});

test('a re-run restores the message and drops an input the workflow no longer declares', async () => {
  offer({ name: 'build', inputs: { notes: {} } });
  await rerun({
    message: 'fix the flaky test',
    inputs: { issue: '42', notes: 'be brief' },
    supplied: ['issue', 'notes'],
  });

  expect(container.querySelector('textarea')?.value).toBe('fix the flaky test');
  const body = await start();
  expect(body?.message).toBe('fix the flaky test');
  expect(body?.inputs).toEqual({ notes: 'be brief' });
});
