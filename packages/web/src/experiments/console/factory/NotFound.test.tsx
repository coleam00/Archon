import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryItem } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import { installDom } from '../test-dom.test-helpers';
import { itemDetail, PROJECT, shippedListed } from './item-detail.test-fixtures';
import { WORK_ORDER_WORDS } from './ItemWorkOrder';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import { isItemsRead, itemsReadAnswer } from './lib/fixtures/factory-items-page';

// A read that answers 404 and one that gets no answer differ only once a read is mounted and
// fails, and only a click can press Retry.
const { mount } = await installDom();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidate('factory-views');
  invalidate('factory-items');
  invalidate('factory-workflow');
  invalidate(K.project(PROJECT));
});

const ITEMS: FactoryItem[] = (['1', '2', '3', '6'] as const).map(key => itemDetail(key).item);

const offline = (): Response => {
  throw new TypeError('Failed to fetch');
};
const notFound = (error: string) => (): Response => Response.json({ error }, { status: 404 });

interface Answers {
  views: () => Response;
  item: () => Response | Promise<Response>;
  items: (url: string) => Response;
  workflow: () => Response;
}

/** The stubbed server: each read answers as `answers` says at the time of the request. */
function serve(answers: Answers): { fetches: Record<keyof Answers, number> } {
  const fetches = { views: 0, item: 0, items: 0, workflow: 0 };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/factory/views')) {
        fetches.views++;
        return answers.views();
      }
      if (url.includes('/api/factory/item?')) {
        fetches.item++;
        return answers.item();
      }
      if (url.includes('/api/factory/workflow')) {
        fetches.workflow++;
        return answers.workflow();
      }
      if (isItemsRead(url)) {
        fetches.items++;
        return answers.items(url);
      }
      if (url.includes('/api/runs/attention'))
        return Response.json({ items: [], runs: [], degraded: [] });
      return Response.json({ error: 'not in this test' }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect }
  );
  return { fetches };
}

const healthy: Answers = {
  views: () => Response.json({ views: [shippedListed], errors: [] }),
  item: notFound('No such item in this project'),
  items: itemsReadAnswer(ITEMS),
  workflow: () => Response.json(deliverJson),
};

const settle = (ms = 0): Promise<void> =>
  act(async () => new Promise(resolve => setTimeout(resolve, ms)));

const words = (container: HTMLElement): string =>
  (container.textContent ?? '').replace(/\s+/g, ' ');

async function renderAt(
  path: string,
  check: (container: HTMLElement) => Promise<void>
): Promise<void> {
  set(K.projectAttention(PROJECT), { items: [], runs: [], degraded: [] });
  const { container, unmount } = await mount(
    <MemoryRouter initialEntries={[`/console/p/${PROJECT}/factory/${path}`]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
  try {
    await settle();
    await settle();
    await check(container);
  } finally {
    await unmount();
  }
}

async function click(button: HTMLElement | null | undefined): Promise<void> {
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await settle();
}

describe('an item', () => {
  test('that does not exist says so, links the board and offers a search', async () => {
    serve(healthy);
    await renderAt('items/9999', async container => {
      expect(words(container)).toContain('There is no item #9999 in this project.');
      expect(words(container)).not.toContain('could not be read');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      const board = [...container.querySelectorAll('a')].find(
        link => link.textContent === 'Open the board'
      );
      expect(board?.getAttribute('href')).toBe(`/console/p/${PROJECT}/factory/board`);
      expect(container.querySelector('input[type="search"]')).not.toBeNull();
    });
  });

  test("an order no item row holds, named by a member's order run: its page from the items read", async () => {
    const { item } = itemDetail('3');
    const member = { ...item, progress: { ...item.progress!, partOf: '48' } };
    serve({ ...healthy, items: itemsReadAnswer([member]) });
    await renderAt('items/48', async container => {
      expect(words(container)).toContain(WORK_ORDER_WORDS);
      expect(words(container)).toContain('Back to the overview#48Work order #48');
      expect(words(container)).toContain('Members: 0 of 1 merged');
      expect(words(container)).not.toContain('could not be read');
    });
  });

  test('whose read got no answer says why, and Retry reads it again and draws the item', async () => {
    const answers: Answers = { ...healthy, item: offline };
    serve(answers);
    await renderAt('items/3', async container => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Item #3 could not be read: the server did not answer');
      expect(words(container)).not.toContain('There is no item');
      answers.item = () => Response.json(itemDetail('3'));
      await click(container.querySelector<HTMLButtonElement>('[role="alert"] button'));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(words(container)).toContain(itemDetail('3').item.progress?.title ?? '');
    });
  });

  test('not found while the items read failed is not called missing, and Retry reads the items', async () => {
    const answers: Answers = { ...healthy, items: offline };
    const { fetches } = serve(answers);
    await renderAt('items/9999', async container => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Item #9999 could not be checked');
      expect(alert?.textContent).toContain('the server did not answer');
      expect(words(container)).not.toContain('There is no item');
      const before = fetches.items;
      answers.items = itemsReadAnswer(ITEMS);
      await click(alert?.querySelector('button'));
      expect(fetches.items).toBeGreaterThan(before);
      expect(words(container)).toContain('There is no item #9999 in this project.');
    });
  });
});

describe('a step', () => {
  test('of a workflow no stage runs says there is no such workflow, and links the Overview', async () => {
    serve({
      ...healthy,
      workflow: notFound('This factory has no stage that runs the workflow nope.'),
    });
    await renderAt('steps/nope/x', async container => {
      expect(words(container)).toContain('There is no workflow nope in this factory.');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      const overview = [...container.querySelectorAll('a')].find(
        link => link.textContent === 'Open the Overview'
      );
      expect(overview?.getAttribute('href')).toBe(`/console/p/${PROJECT}/factory`);
    });
  });
});
