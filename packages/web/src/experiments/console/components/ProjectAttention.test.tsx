import { afterAll, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router';
import { invalidate } from '../store/cache';
import { shippedListed } from '../factory/item-detail.test-fixtures';
import { projectRoutes } from '../routes/project-routes';
import { installDom } from '../test-dom.test-helpers';

// The section's stream is opened by an effect, so this test mounts a live React tree.
const { mount, settle } = await installDom();

/** Every EventSource the pages open, by URL, and whether each was closed. */
const opened: { url: string; closed: boolean }[] = [];
class CountingEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  private readonly entry: { url: string; closed: boolean };
  constructor(url: string) {
    this.entry = { url, closed: false };
    opened.push(this.entry);
  }
  close(): void {
    this.readyState = 2;
    this.entry.closed = true;
  }
}
// The harness puts back the EventSource it found, after the file.
globalThis.EventSource = CountingEventSource as unknown as typeof EventSource;
const unserved = globalThis.fetch;

afterAll(() => {
  for (const prefix of [
    'factory-views',
    'factory-workflow',
    'factory-items',
    'factory-item',
    'runs',
  ])
    invalidate(prefix);
});

const ID = 'cb-1';

// The pages only need a view to draw their frame; every other read may fail here.
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/factory/views'))
      return Response.json({ views: [shippedListed], errors: [] });
    if (url.includes('/api/runs/attention'))
      return Response.json({ items: [], runs: [], degraded: [] });
    return Response.json({ error: 'not in this test' }, { status: 404 });
  },
  { preconnect: unserved.preconnect }
);

let navigate: NavigateFunction | undefined;
function Navigator(): null {
  navigate = useNavigate();
  return null;
}

const attentionStreams = (): { url: string; closed: boolean }[] =>
  opened.filter(entry => entry.url.includes('/api/runs/attention/stream'));

test('a project keeps one attention stream across its pages and closes it on leaving the project', async () => {
  const { container, unmount } = await mount(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory`]}>
      <Navigator />
      <Routes>
        {projectRoutes('/console/')}
        <Route path="/console/elsewhere" element={<p>elsewhere</p>} />
      </Routes>
    </MemoryRouter>
  );
  await settle();
  // The frame drew under a view, so the page reads the section's queue.
  expect(container.textContent).toContain(shippedListed.declaration.title);

  for (const rest of ['/board', '/items/39', '/steps/plan/plan', '']) {
    await act(async () => navigate?.(`/console/p/${ID}/factory${rest}`));
    await settle();
    expect(container.textContent).toContain(shippedListed.declaration.title);
  }
  // The Needs you tab is a project page too: the same stream.
  await act(async () => navigate?.(`/console/p/${ID}/needs-you`));
  await settle();
  expect(container.textContent).toContain('Nothing needs you');
  expect(attentionStreams()).toEqual([
    { url: expect.stringContaining(`project=${ID}`) as unknown as string, closed: false },
  ]);

  await act(async () => navigate?.('/console/elsewhere'));
  await settle();
  expect(container.textContent).toBe('elsewhere');
  expect(attentionStreams()).toHaveLength(1);
  expect(attentionStreams()[0]?.closed).toBe(true);

  await unmount();
});
