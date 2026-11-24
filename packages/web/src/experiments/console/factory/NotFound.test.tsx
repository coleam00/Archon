import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryItem } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import { itemDetail, PROJECT, shippedListed } from './item-detail.test-fixtures';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import { isItemsRead, itemsReadAnswer } from './lib/fixtures/factory-items-page';

// A read that answers 404 and one that gets no answer differ only once a read is mounted and
// fails, and only a click can press Retry.
const dom = new Window({ url: 'http://localhost' });
// The frame keeps the Needs-you count live over SSE; nothing streams in this test.
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

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
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/console/p/${PROJECT}/factory/${path}`]}>
          <Routes>{projectRoutes('/console/')}</Routes>
        </MemoryRouter>
      )
    );
    await settle();
    await settle();
    await check(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
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

async function type(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(input?.getAttribute('aria-label')).toBe('Find an item by key or title');
  await act(async () => {
    // React listens for the native input event; set the value the way a keystroke does.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, text);
    input?.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  });
}

const hrefs = (container: HTMLElement, selector: string): string[] =>
  [...container.querySelectorAll<HTMLAnchorElement>(`${selector} a`)].map(
    link => link.getAttribute('href') ?? ''
  );

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

  test('whose read got no answer says why, and Retry reads it again and draws the item', async () => {
    const answers: Answers = { ...healthy, item: offline };
    const { fetches } = serve(answers);
    await renderAt('items/3', async container => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Item #3 could not be read: the server did not answer');
      expect(words(container)).not.toContain('There is no item');
      // While the retry waits, the held failure gives way to the page's loading shape.
      let fail: (error: Error) => void = () => undefined;
      answers.item = () =>
        new Promise<Response>((_resolve, reject) => {
          fail = reject;
        });
      const before = fetches.item;
      await click(alert?.querySelector('button'));
      expect(fetches.item).toBe(before + 1);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(words(container)).toContain('Loading the item');
      // Still offline: the new failure shows.
      await act(async () => fail(new TypeError('Failed to fetch')));
      await settle();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'the server did not answer'
      );
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

  test('search lists the closest items as links, the exact key first, and says when none match', async () => {
    serve(healthy);
    await renderAt('items/9999', async container => {
      // Nothing is listed before the person types.
      expect(container.querySelector('[aria-label="Matching items"]')).toBeNull();
      await type(container, '3');
      const links = hrefs(container, '[aria-label="Matching items"]');
      expect(links[0]).toBe(`/console/p/${PROJECT}/factory/items/3`);
      await type(container, 'no item is called this');
      expect(container.querySelector('[aria-label="Matching items"]')).toBeNull();
      expect(words(container)).toContain('No item with a run matches.');
    });
  });
});

describe('a Factory page', () => {
  test('whose factory view read got no answer says so with a Retry, which draws the page', async () => {
    const answers: Answers = { ...healthy, views: offline };
    serve(answers);
    await renderAt('nope', async container => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        'The factory view could not be read: the server did not answer'
      );
      answers.views = healthy.views;
      await click(alert?.querySelector('button'));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(words(container)).toContain('No page here.');
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

  test("of a stage's workflow that answers 404 stays a failure with the server's words", async () => {
    const missing =
      'The pack acme/kit has no workflow deliver in this project, so it cannot be drawn.';
    serve({ ...healthy, workflow: notFound(missing) });
    await renderAt('steps/deliver/x', async container => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(missing);
      expect(words(container)).not.toContain('There is no workflow');
    });
  });

  test('whose workflow read got no answer says why with a Retry', async () => {
    serve({ ...healthy, workflow: offline });
    await renderAt('steps/deliver/nope', async container => {
      // The workflow read tries once more after a second (`NETWORK_RETRY_MS`).
      await settle(1_100);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        'Could not read the workflow deliver: the server did not answer'
      );
      expect(alert?.querySelector('button')?.textContent).toBe('Retry');
      expect(words(container)).not.toContain('There is no step');
    });
  });
});
