import { afterAll, afterEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import {
  DRY_RUN_CONTEXT,
  DRY_RUN_ROUTES,
  DRY_RUN_WHY,
  MARKER,
} from '../../lib/ask-offered.test-fixtures';
import { askNaming } from '../../lib/ask-naming';
import { askItem, gateItem } from '../../lib/needs-you.test-fixtures';
import { shippedView } from '../../factory/item-detail.test-fixtures';
import type { NeedsYouItem } from '../../lib/needs-you';
import { toRun } from '../../primitives/run';
import { get, set } from '../../store/cache';
import { K } from '../../store/keys';
import { AskCard, SubjectName } from './AskCard';
import { AskGroup } from './AskGroup';
import { ANSWERED_SHOWN_MS } from './useAnsweredHold';
import { holding, LONG, wrapsAnywhere } from './wrap.test-fixtures';

// Choosing, confirming and folding re-render the card, which static markup cannot reach.
const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** Every request the card sends, by path, with its body. */
function serve(answer: () => Response = () => Response.json({ success: true })) {
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return answer();
    },
    { preconnect: originalFetch.preconnect }
  );
  return requests;
}

/**
 * One item's asks, as a popover over a board card would mount them: the group alone, with
 * its props and no page, route or provider around it (a router only for its links).
 */
async function mount(
  asks: NeedsYouItem[],
  runs: ReturnType<typeof toRun>[] = [],
  starts?: (ask: NeedsYouItem, optionId: string) => string | undefined
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (current: NeedsYouItem[]): ReactElement => (
    <MemoryRouter>
      <AskGroup projectId="cb-1" asks={current} queue={{ runs }} starts={starts} />
    </MemoryRouter>
  );
  await act(async () => root.render(render(asks)));
  const button = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find(candidate =>
      candidate.textContent?.startsWith(label)
    );
    if (found === undefined) throw new Error(`No button "${label}"`);
    return found;
  };
  return {
    container,
    button,
    click: async (label: string): Promise<void> => {
      await act(async () => {
        button(label).click();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    type: async (text: string): Promise<void> => {
      const box = container.querySelector('textarea');
      if (box === null) throw new Error('No textarea');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(box) as object,
          'value'
        )?.set;
        setter?.call(box, text);
        box.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
      });
    },
    rerender: async (current: NeedsYouItem[]): Promise<void> => {
      await act(async () => root.render(render(current)));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('a tile sends nothing; it shows Answer: <label>, Cancel clears it, Confirm answers by ref', async () => {
  const requests = serve();
  const card = await mount([askItem({ ref: 'ask:1' })]);
  try {
    await card.click('Use main');
    expect(requests).toEqual([]);
    expect(card.container.textContent).toContain('Answer: Use main');
    await card.click('Cancel');
    expect(card.container.textContent).not.toContain('Answer: Use main');

    await card.click('Use dev');
    await card.type('On dev, please.');
    await card.click('Confirm');
    expect(requests).toEqual([
      {
        path: '/api/attention/answer',
        body: { ref: 'ask:1', choose: ['use-dev'], text: 'On dev, please.' },
      },
    ]);
  } finally {
    await card.unmount();
  }
});

test('a chosen tile shows what its option does and costs whole, not only in a tooltip', async () => {
  serve();
  const long =
    'The merged change contradicts DESIGN.md on a member page and can list a refused order as members.';
  const ask = askItem({
    ref: 'ask:1',
    options: [
      { id: 'use-main', label: 'Use main', does: 'Rebases onto main.', cost: long },
      { id: 'use-dev', label: 'Use dev', does: 'Rebases onto dev.', cost: 'One more rebase.' },
    ],
  });
  const card = await mount([ask]);
  try {
    const costLine = (): HTMLElement | undefined =>
      [...card.button('Use main').querySelectorAll('span')].find(span =>
        span.textContent?.startsWith('Cost:')
      );
    // At rest it clamps to 2 lines; chosen, the cost is text in full, unclamped.
    expect(costLine()?.className).toContain('line-clamp-2');
    await card.click('Use main');
    expect(costLine()?.textContent).toBe(`Cost: ${long}`);
    expect(costLine()?.className).not.toContain('line-clamp');
  } finally {
    await card.unmount();
  }
});

test('once answered the card says so in place, then folds away after 5 s', async () => {
  serve();
  const ask = askItem({ ref: 'ask:1' });
  const card = await mount([ask]);
  try {
    jest.useFakeTimers();
    await card.click('Use dev');
    await card.click('Confirm');
    // The queue refreshes without the ask; the card stays, saying what was answered.
    await card.rerender([]);
    expect(card.container.querySelector('[role="status"]')?.textContent).toBe('Answered: Use dev');
    expect(card.container.querySelector('[aria-label="Options"]')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(ANSWERED_SHOWN_MS - 1);
    });
    expect(card.container.textContent).toContain('Answered: Use dev');
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(card.container.querySelector('[data-ask]')).toBeNull();
  } finally {
    await card.unmount();
  }
});

test('an answered card keeps its place among asks paused at the same time', async () => {
  serve();
  const first = askItem({ ref: 'ask:1', message: 'First?' });
  const second = askItem({ ref: 'ask:2', message: 'Second?' });
  const card = await mount([first, second]);
  try {
    await card.click('Use dev');
    await card.click('Confirm');
    await card.rerender([second]);
    const order = [...card.container.querySelectorAll('[data-ask]')].map(node =>
      node.getAttribute('data-ask')
    );
    expect(order).toEqual(['ask:1', 'ask:2']);
  } finally {
    await card.unmount();
  }
});

test("a refusal shows the server's words in the card, which stays open, and the queue refreshes", async () => {
  const refusal = "Item 'ask:gone' is no longer open";
  serve(() => Response.json({ error: refusal }, { status: 409 }));
  set(K.projectAttention('cb-1'), { items: [], runs: [], degraded: [] });
  const card = await mount([askItem({ ref: 'ask:gone' })]);
  try {
    await card.click('Use dev');
    await card.click('Confirm');
    expect(card.container.querySelector('[role="alert"]')?.textContent).toBe(refusal);
    expect(card.container.textContent).toContain('Answer: Use dev');
    // No subscriber holds the key here, so the refresh drops the cached queue.
    expect(get(K.projectAttention('cb-1'))).toBeUndefined();
  } finally {
    await card.unmount();
  }
});

test('a gate draws its decisions as tiles and responds through the gate, reasons required', async () => {
  const requests = serve();
  const gate = gateItem({ ref: 'gate:1' });
  const run = toRun({
    id: 'run-gate',
    workflow_name: 'deliver',
    codebase_id: 'cb-1',
    status: 'paused',
    started_at: '2026-11-16T09:00:00.000Z',
    metadata: {
      approval: {
        nodeId: 'review',
        message: 'Approve the plan?',
        type: 'approval',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
      },
    },
  });
  const card = await mount([gate], [run]);
  try {
    expect(card.container.textContent).toContain('Approve the plan?');
    await card.click('Reject');
    expect(card.button('Confirm').disabled).toBe(true);
    await card.type('The plan skips the migration.');
    await card.click('Confirm');
    expect(requests).toEqual([
      {
        path: '/api/workflows/runs/run-gate/respond',
        body: { decision: 'reject', text: 'The plan skips the migration.' },
      },
    ]);
  } finally {
    await card.unmount();
  }
});

/** The option tiles, in the order drawn. */
const tiles = (container: HTMLElement): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Options"] button'),
];
/**
 * The mark drawn on `el` (its border is a style, which happy-dom cannot parse; tile-marks.tsx
 * says why it is a style, and the browser check reads the computed colour).
 */
const markOf = (el: Element | null | undefined): string | null =>
  el?.getAttribute('data-mark') ?? null;
/** A tile drawn as chosen: the selected border or the check. */
const looksSelected = (tile: HTMLElement): boolean =>
  markOf(tile) === 'selected' || tile.querySelector('svg') !== null;
/**
 * The labels of the tiles that pass `which`, as strings: a failing `toEqual` on happy-dom
 * elements makes bun hang printing the diff, so selection tests compare words, never elements.
 */
const labelsWhere = (container: HTMLElement, which: (tile: HTMLElement) => boolean): string[] =>
  tiles(container)
    .filter(which)
    .map(tile => tile.querySelector('span > span')?.textContent ?? '');
const pressed = (tile: HTMLElement): boolean => tile.getAttribute('aria-pressed') === 'true';

test('before any pick nothing looks selected; the recommended tile is green with its badge', async () => {
  serve();
  const card = await mount([
    askItem({
      options: [
        { id: 'use-main', label: 'Use main' },
        { id: 'use-dev', label: 'Use dev' },
        { id: 'use-next', label: 'Use next' },
        { id: 'skip', label: 'Skip it' },
      ],
    }),
  ]);
  try {
    const all = tiles(card.container);
    expect(all.length).toBe(4);
    expect(labelsWhere(card.container, looksSelected)).toEqual([]);
    expect(labelsWhere(card.container, pressed)).toEqual([]);
    const recommended = all.filter(tile => tile.dataset.recommended === 'true');
    expect(labelsWhere(card.container, tile => tile.dataset.recommended === 'true')).toEqual([
      'Use dev',
    ]);
    expect(recommended[0]?.classList.contains('bg-[color:var(--success-soft)]')).toBe(true);
    expect(markOf(recommended[0])).toBe('recommended');
    expect(recommended[0]?.textContent).toContain('Recommended');
  } finally {
    await card.unmount();
  }
});

test('picking a tile the ask does not recommend: that tile alone looks selected', async () => {
  serve();
  const card = await mount([askItem()]);
  try {
    await card.click('Use main');
    expect(labelsWhere(card.container, looksSelected)).toEqual(['Use main']);
    expect(labelsWhere(card.container, pressed)).toEqual(['Use main']);
    // No other tile wears the chosen tile's look.
    const chosen = card.button('Use main').className;
    expect(tiles(card.container).filter(tile => tile.className === chosen).length).toBe(1);
    // The recommended tile keeps only its green mark.
    const recommended = card.button('Use dev');
    expect(looksSelected(recommended)).toBe(false);
    expect(markOf(recommended)).toBe('recommended');
  } finally {
    await card.unmount();
  }
});

test('picking the recommended tile: selected, keeping its badge, with one border colour', async () => {
  serve();
  const card = await mount([askItem()]);
  try {
    await card.click('Use dev');
    const tile = card.button('Use dev');
    expect(labelsWhere(card.container, looksSelected)).toEqual(['Use dev']);
    expect(labelsWhere(card.container, pressed)).toEqual(['Use dev']);
    expect(markOf(tile)).toBe('selected');
    expect(tile.textContent).toContain('Recommended');
  } finally {
    await card.unmount();
  }
});

test('Confirm is the accent at reduced strength, never the full-strength block', async () => {
  serve();
  const card = await mount([askItem()]);
  try {
    await card.click('Use main');
    const confirm = card.button('Confirm');
    expect(confirm.classList.contains('bg-[color:var(--accent-soft)]')).toBe(true);
    expect(confirm.classList.contains('text-accent')).toBe(true);
    expect(confirm.style.getPropertyValue('border-color')).toBe('var(--accent-muted)');
    expect(confirm.classList.contains('bg-accent')).toBe(false);
    expect(confirm.classList.contains('text-white')).toBe(false);
  } finally {
    await card.unmount();
  }
});

test('a long unbroken path in every text field wraps inside its tile and the card', async () => {
  serve();
  const [question, context, label, does, cost, why] = [
    'question',
    'context',
    'label',
    'does',
    'cost',
    'why',
  ].map(field => `${field}:${LONG}`) as [string, string, string, string, string, string];
  const card = await mount([
    askItem({
      message: question,
      context,
      options: [
        { id: 'long', label, does, cost },
        { id: 'use-dev', label: 'Use dev' },
      ],
      recommendation: { option: 'use-dev', why },
    }),
  ]);
  try {
    const article = card.container.querySelector('article[data-ask]');
    if (article === null) throw new Error('No card');
    const tile = card.button(label);
    const inTile = [label, does, cost];
    for (const text of [question, context, label, does, cost, why]) {
      const found = holding(article, text);
      expect(found.length).toBeGreaterThan(0);
      const box = inTile.includes(text) ? tile : article;
      for (const el of found) expect([text, wrapsAnywhere(el, box)]).toEqual([text, true]);
    }
    expect(article.classList.contains('min-w-0')).toBe(true);
    for (const each of tiles(card.container))
      expect(each.classList.contains('max-w-full')).toBe(true);
    // Chosen, the tile shows its words whole; they still wrap.
    await card.click(label);
    for (const text of inTile)
      for (const el of holding(tile, text)) expect(wrapsAnywhere(el, tile)).toBe(true);
  } finally {
    await card.unmount();
  }
});

test("the Overview's compact card wraps a long question and label, and marks the tile green", async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const question = `question:${LONG}`;
  const label = `label:${LONG}`;
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AskCard
            projectId="cb-1"
            ask={askItem({
              message: question,
              options: [{ id: 'long', label }],
              recommendation: { option: 'long', why: 'Why.' },
            })}
            queue={{ runs: [] }}
            variant="compact"
            openHref="/console/p/cb-1/needs-you"
          />
        </MemoryRouter>
      )
    );
    const article = container.querySelector('article[data-ask]');
    if (article === null) throw new Error('No card');
    for (const text of [question, label])
      for (const el of holding(article, text)) expect(wrapsAnywhere(el, article)).toBe(true);
    expect(article.classList.contains('min-w-0')).toBe(true);
    // The tile is not a control and nothing is chosen: green, never the accent.
    const tile = holding(article, label)[0]?.parentElement;
    expect(markOf(tile)).toBe('recommended');
    expect(tile?.className).not.toContain('accent');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('the item key never shrinks or wraps beside a long title; the title truncates', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SubjectName
            subject={{ key: '91', partOf: null, title: `title:${LONG}`, href: '/console/p/cb-1' }}
          />
        </MemoryRouter>
      )
    );
    const key = holding(container, '#91').find(el => el.textContent === '#91');
    if (key === undefined) throw new Error('No key');
    // A wrap class or a shrinkable key splits '91' into '9' over '1' (PR #97 review).
    expect(key.className).not.toContain('overflow-wrap');
    expect(key.className).not.toContain('break-');
    expect(key.classList.contains('min-w-0')).toBe(false);
    expect(key.classList.contains('shrink-0')).toBe(true);
    expect(key.classList.contains('whitespace-nowrap')).toBe(true);
    expect(holding(container, 'title:')[0]?.classList.contains('truncate')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** An ask of the shape the pack's delivery leaves: four routes, the stage's own options in the context. */
const dryRunAsk = (overrides: Partial<Parameters<typeof askItem>[0]> = {}): NeedsYouItem =>
  askItem({
    message:
      'The review and the product check disagree on whether the empty state is in scope. Which stands?',
    context: DRY_RUN_CONTEXT,
    options: DRY_RUN_ROUTES,
    recommendation: { option: 'send-back', why: DRY_RUN_WHY },
    ...overrides,
  });

test('what the stage offered shows whole between the question and the tiles, the recommended one marked', async () => {
  serve();
  const card = await mount([dryRunAsk()]);
  try {
    const article = card.container.querySelector('article[data-ask]');
    const offered = card.container.querySelector('section[aria-label="What the stage offered"]');
    const question = article?.querySelector('h3');
    const options = card.container.querySelector('[role=group][aria-label=Options]');
    if (!article || !offered || !question || !options) throw new Error('Missing part of the card');
    const follows = (a: Node, b: Node): boolean =>
      (a.compareDocumentPosition(b) & dom.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect([follows(question, offered), follows(offered, options)]).toEqual([true, true]);

    expect(offered.textContent).toContain('What the stage offered');
    for (const text of [
      'Build it',
      'Build the empty state now.',
      'Cost: One more round.',
      'Leave it',
      'Leave it for a follow-up item.',
      'Cost: The board shows a blank column until then.',
    ])
      expect([text, offered.textContent?.includes(text)]).toEqual([text, true]);
    // Never the raw id, and nothing in it is clamped.
    expect(offered.textContent).not.toContain('build-it');
    expect(offered.querySelectorAll('[class*="line-clamp"]').length).toBe(0);

    // The rest of the context keeps its clamp and loses the list.
    const clamped = article.querySelector('p.line-clamp-3');
    expect(clamped?.textContent).toBe(
      'Review says the item asks for it; product says it was never mentioned. (Left by: verdict.)'
    );

    const rows = [...offered.querySelectorAll('li')];
    expect(rows.map(row => [markOf(row), row.textContent?.includes('Recommended')])).toEqual([
      ['recommended', true],
      [null, false],
    ]);
    expect(rows[0]?.classList.contains('bg-[color:var(--success-soft)]')).toBe(true);
    expect(offered.querySelectorAll('button').length).toBe(0);
  } finally {
    await card.unmount();
  }
});

test("with an offered list, a tile pick's note asks which of them is meant", async () => {
  serve();
  // The engine appends the reserved option last on an ask declared `other: true`.
  const card = await mount([
    dryRunAsk({ options: [...DRY_RUN_ROUTES, { id: 'other', label: 'Other' }], other: true }),
  ]);
  try {
    await card.click('Send back');
    expect(card.container.querySelector('textarea')?.placeholder).toBe(
      'Say which the stage offered you mean: Build it or Leave it'
    );
    // Something else is answered in words, so it keeps its own prompt.
    await card.click('Cancel');
    expect(card.button('Something else').textContent).toContain('Write your own answer');
    await card.click('Something else');
    expect(card.container.querySelector('textarea')?.placeholder).toBe('Say what to do instead');
  } finally {
    await card.unmount();
  }
});

test('an ask without the marker draws its whole context clamped and no offered list', async () => {
  serve();
  const card = await mount([askItem()]);
  try {
    expect(card.container.querySelector('section[aria-label="What the stage offered"]')).toBeNull();
    expect(card.container.querySelector('p.line-clamp-3')?.textContent).toBe(
      'The branch was cut from main but the item names dev.'
    );
    await card.click('Use main');
    expect(card.container.querySelector('textarea')?.placeholder).toBe(
      'Optional note with your answer'
    );
  } finally {
    await card.unmount();
  }
});

test("a long unbroken path in an offered option's words wraps inside the card", async () => {
  serve();
  const [does, cost] = [`does:${LONG}`, `cost:${LONG}`] as const;
  const card = await mount([
    dryRunAsk({ context: `${MARKER}\n- long-one: ${does} (cost: ${cost})` }),
  ]);
  try {
    const article = card.container.querySelector('article[data-ask]');
    if (article === null) throw new Error('No card');
    // Only the list, so no clamped rest above it.
    expect(article.querySelector('p.line-clamp-3')).toBeNull();
    for (const text of [does, cost]) {
      const found = holding(article, text);
      expect(found.length).toBeGreaterThan(0);
      for (const el of found) expect([text, wrapsAnywhere(el, article)]).toEqual([text, true]);
    }
  } finally {
    await card.unmount();
  }
});

/** The routes every delivery ask of the pack's `ending.ts` offers (pack d7f8c36), rounds left. */
const PACK_ROUTES = [
  {
    id: 'send-back',
    does: 'The same builder continues on the change with what you say in your answer, and the checks look at it again.',
    cost: 'One build run and one check round.',
  },
  {
    id: 'replan',
    does: 'The item goes back to planning with what you say in your answer.',
    cost: 'The work so far may be discarded.',
  },
  {
    id: 'take-as-is',
    does: 'The change goes on to the host round as it is.',
    cost: 'What was returned stays unfixed.',
  },
  {
    id: 'drop',
    does: 'The change is closed without merging and the item ends here. Your answer is written on the change as the reason.',
    cost: 'The work on this change is given up; its branch stays.',
  },
  {
    id: 'reshape',
    does: 'The change stays open as a draft and nothing more is built until the item is shaped again. Your answer is written on the change.',
    cost: 'The item waits for shaping, and the draft can stop merging while it does.',
  },
];
/** A stage-check ask of that shape; a `recommendation: null` the pack writes reaches it absent. */
const packAsk = (context: string, recommended = true): NeedsYouItem => {
  const { recommendation, ...ask } = askItem({
    askedIn: { runId: 'run-check', workflow: 'Wirasm/archon-software-factory:stage-check' },
    message: 'The checks returned the change again. What should happen to it now?',
    context,
    options: PACK_ROUTES,
    recommendation: { option: 'send-back', why: 'What was returned is small.' },
  });
  return recommended ? { ...ask, recommendation } : ask;
};
const viewStarts = askNaming('cb-1', { declaration: shippedView }).starts;
const startsOf = (tile: HTMLElement): string | null =>
  tile.querySelector('[data-starts]')?.textContent ?? null;

test("drop and reshape tiles say what they start, in the view's words; the other routes do not", async () => {
  serve();
  const card = await mount([packAsk('The checks returned it.')], [], viewStarts);
  try {
    expect(
      ['Send back', 'Replan', 'Take as is', 'Drop', 'Reshape'].map(label => [
        label,
        startsOf(card.button(label)),
      ])
    ).toEqual([
      ['Send back', null],
      ['Replan', null],
      ['Take as is', null],
      ['Drop', 'Closes the PR without merging'],
      ['Reshape', 'Leaves the PR as a draft until the item is shaped'],
    ]);
    // Read whole, never clamped, and named in the tile's title for hover too.
    const drop = card.button('Drop');
    expect(drop.querySelector('[data-starts]')?.className).not.toContain('line-clamp');
    expect(drop.title.split('\n')[0]).toBe('Closes the PR without merging');
  } finally {
    await card.unmount();
  }
});

test('an ask the stage left without a recommendation marks no tile and says why under them', async () => {
  serve();
  const card = await mount(
    [
      packAsk(
        'Round 3 of 3 allowed on this item.\n\nNo recommendation: the judgment of what is left did not run.',
        false
      ),
    ],
    [],
    viewStarts
  );
  try {
    expect(card.container.querySelector('[data-recommended]')).toBeNull();
    expect(card.container.textContent).not.toContain('Recommended');
    const why = card.container.querySelector('[data-unrecommended]');
    expect(why?.textContent).toBe(
      'The stage could not choose: the judgment of what is left did not run.'
    );
    const options = card.container.querySelector('[role=group][aria-label=Options]');
    if (why === null || options === null) throw new Error('Missing part of the card');
    expect(
      (options.compareDocumentPosition(why) & dom.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    ).toBe(true);
    // The reason is said once: the clamped context loses its paragraph.
    expect(card.container.querySelector('p.line-clamp-3')?.textContent).toBe(
      'Round 3 of 3 allowed on this item.'
    );
    // Declared order: no tile moves first.
    expect(card.container.querySelector('[role=group] button')?.textContent).toContain('Send back');
  } finally {
    await card.unmount();
  }
});

test('a recommended ask quoting the marker keeps its context whole and its green tile', async () => {
  serve();
  const context = 'Left.\n\nNo recommendation: quoted from the script.';
  const card = await mount([packAsk(context)]);
  try {
    expect(card.container.querySelector('[data-unrecommended]')).toBeNull();
    expect(card.container.querySelector('[data-recommended]')?.textContent).toContain('Send back');
    expect(card.container.querySelector('p.line-clamp-3')?.textContent).toBe(context);
  } finally {
    await card.unmount();
  }
});
