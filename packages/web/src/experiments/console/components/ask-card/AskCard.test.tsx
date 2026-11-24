import { afterEach, expect, jest, test } from 'bun:test';
import { act, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { DRY_RUN_CONTEXT, DRY_RUN_ROUTES, DRY_RUN_WHY } from '../../lib/ask-offered.test-fixtures';
import { askNaming } from '../../lib/ask-naming';
import { askItem, gateItem } from '../../lib/needs-you.test-fixtures';
import { shippedView } from '../../factory/item-detail.test-fixtures';
import type { NeedsYouItem } from '../../lib/needs-you';
import { toRun } from '../../primitives/run';
import { get, set } from '../../store/cache';
import { K } from '../../store/keys';
import { installDom } from '../../test-dom.test-helpers';
import { AskGroup } from './AskGroup';
import { ANSWERED_SHOWN_MS } from './useAnsweredHold';
import { LONG } from './wrap.test-fixtures';

// Choosing, confirming and folding re-render the card, which static markup cannot reach.
const { dom, mount: mountTree } = await installDom();
const unserved = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = unserved;
});

/** Every request the card sends, by path, with its body. */
function serve(answer: () => Response = () => Response.json({ success: true })) {
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return answer();
    },
    { preconnect: unserved.preconnect }
  );
  return requests;
}

/** One item's asks, as a popover over a board card mounts them: the group alone. */
async function mount(
  asks: NeedsYouItem[],
  runs: ReturnType<typeof toRun>[] = [],
  starts?: (ask: NeedsYouItem, optionId: string) => string | undefined
) {
  let setAsks: (next: NeedsYouItem[]) => void = () => undefined;
  function Host() {
    const [current, setCurrent] = useState(asks);
    setAsks = setCurrent;
    return <AskGroup projectId="cb-1" asks={current} queue={{ runs }} starts={starts} />;
  }
  const { container, unmount } = await mountTree(
    <MemoryRouter>
      <Host />
    </MemoryRouter>
  );
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
    unmount,
    text: (): string => container.textContent ?? '',
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
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box) as object, 'value')?.set?.call(
          box,
          text
        );
        box.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
      });
    },
    rerender: async (next: NeedsYouItem[]): Promise<void> => {
      await act(async () => setAsks(next));
    },
  };
}

/** The labels of the option tiles that are pressed, and the one marked recommended. */
const tileState = (container: HTMLElement) => {
  const tiles = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Options"] button')];
  const label = (tile: HTMLElement) => tile.querySelector('span > span')?.textContent ?? '';
  return {
    pressed: tiles.filter(tile => tile.getAttribute('aria-pressed') === 'true').map(label),
    recommended: tiles.filter(tile => tile.dataset.recommended === 'true').map(label),
  };
};

test('two asks: pick, cancel, confirm by ref, then "Answered" in place, in order, folding after the hold', async () => {
  const requests = serve();
  const first = askItem({ ref: 'ask:1', context: `See ${LONG}` });
  const second = askItem({ ref: 'ask:2', message: 'Second?' });
  const card = await mount([first, second]);
  try {
    // The long path shows whole; nothing is chosen until a tile is picked.
    expect(card.text()).toContain(LONG);
    const [firstCard] = card.container.querySelectorAll<HTMLElement>('article[data-ask]');
    if (firstCard === undefined) throw new Error('No card');
    expect(tileState(firstCard)).toEqual({ pressed: [], recommended: ['Use dev'] });
    expect(firstCard.textContent).toContain('Recommended');

    await card.click('Use main');
    expect(requests).toEqual([]);
    expect(tileState(firstCard).pressed).toEqual(['Use main']);
    // Chosen, the tile shows what its option costs.
    expect(card.button('Use main').textContent).toContain('Cost: Drops dev fixes.');
    expect(card.text()).toContain('Answer: Use main');
    await card.click('Cancel');
    expect(card.text()).not.toContain('Answer: Use main');

    jest.useFakeTimers();
    await card.click('Use dev');
    await card.type('On dev, please.');
    await card.click('Confirm');
    expect(requests).toEqual([
      {
        path: '/api/attention/answer',
        body: { ref: 'ask:1', choose: ['use-dev'], text: 'On dev, please.' },
      },
    ]);
    // The queue refreshes without the ask; the card stays where it was, saying what was answered.
    await card.rerender([second]);
    const order = [...card.container.querySelectorAll('[data-ask]')].map(node =>
      node.getAttribute('data-ask')
    );
    expect(order).toEqual(['ask:1', 'ask:2']);
    expect(card.container.querySelector('[role="status"]')?.textContent).toBe('Answered: Use dev');
    await act(async () => {
      jest.advanceTimersByTime(ANSWERED_SHOWN_MS - 1);
    });
    expect(card.text()).toContain('Answered: Use dev');
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(card.container.querySelector('[data-ask="ask:1"]')).toBeNull();
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
    expect(card.text()).toContain('Answer: Use dev');
    // No subscriber holds the key here, so the refresh drops the cached queue.
    expect(get(K.projectAttention('cb-1'))).toBeUndefined();
  } finally {
    await card.unmount();
  }
});

test('a gate draws its decisions as tiles and responds through the gate, reasons required', async () => {
  const requests = serve();
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
  const card = await mount([gateItem({ ref: 'gate:1' })], [run]);
  try {
    expect(card.text()).toContain('Approve the plan?');
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

test('what the stage offered shows whole between the question and the tiles, and a pick asks which is meant', async () => {
  serve();
  const card = await mount([
    askItem({
      message: 'Which stands?',
      context: DRY_RUN_CONTEXT,
      options: [...DRY_RUN_ROUTES, { id: 'other', label: 'Other' }],
      other: true,
      recommendation: { option: 'send-back', why: DRY_RUN_WHY },
    }),
  ]);
  try {
    const article = card.container.querySelector('article[data-ask]');
    const offered = card.container.querySelector('section[aria-label="What the stage offered"]');
    const question = article?.querySelector('h3');
    const options = card.container.querySelector('[role=group][aria-label=Options]');
    if (!article || !offered || !question || !options) throw new Error('Missing part of the card');
    const follows = (a: Node, b: Node): boolean =>
      (a.compareDocumentPosition(b) & dom.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect([follows(question, offered), follows(offered, options)]).toEqual([true, true]);
    for (const text of [
      'Build it',
      'Build the empty state now.',
      'Cost: One more round.',
      'Leave it',
      'Cost: The board shows a blank column until then.',
    ])
      expect([text, offered.textContent?.includes(text)]).toEqual([text, true]);
    // Never the raw id; the rest of the context still shows, without the list.
    expect(offered.textContent).not.toContain('build-it');
    expect(article.textContent).toContain('Review says the item asks for it');
    const rows = [...offered.querySelectorAll('li')];
    expect(rows.map(row => row.textContent?.includes('Recommended'))).toEqual([true, false]);
    expect(offered.querySelectorAll('button').length).toBe(0);

    await card.click('Send back');
    expect(card.container.querySelector('textarea')?.placeholder).toBe(
      'Say which the stage offered you mean: Build it or Leave it'
    );
    await card.click('Cancel');
    expect(card.button('Something else').textContent).toContain('Write your own answer');
    await card.click('Something else');
    expect(card.container.querySelector('textarea')?.placeholder).toBe('Say what to do instead');
  } finally {
    await card.unmount();
  }
});

/** The routes a delivery ask of the pack's `ending.ts` offers, with their pack words. */
const PACK_ROUTES = ['send-back', 'replan', 'take-as-is', 'drop', 'reshape'].map(id => ({
  id,
  does: `Does ${id}.`,
  cost: `Costs ${id}.`,
}));
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

test('an unrecommended pack ask: drop and reshape say what they start, no tile is marked, and the reason shows once', async () => {
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
    const startsOf = (label: string) =>
      card.button(label).querySelector('[data-starts]')?.textContent ?? null;
    expect(
      ['Send back', 'Replan', 'Take as is', 'Drop', 'Reshape'].map(label => [
        label,
        startsOf(label),
      ])
    ).toEqual([
      ['Send back', null],
      ['Replan', null],
      ['Take as is', null],
      ['Drop', 'Closes the PR without merging'],
      ['Reshape', 'Leaves the PR as a draft until the item is shaped'],
    ]);
    expect(card.button('Drop').title.split('\n')[0]).toBe('Closes the PR without merging');

    expect(card.container.querySelector('[data-recommended]')).toBeNull();
    expect(card.text()).not.toContain('Recommended');
    const why = card.container.querySelector('[data-unrecommended]');
    expect(why?.textContent).toBe(
      'The stage could not choose: the judgment of what is left did not run.'
    );
    expect(card.text().split('did not run').length - 1).toBe(1);
    expect(card.text()).toContain('Round 3 of 3 allowed on this item.');
    // Declared order: no tile moves first.
    expect(card.container.querySelector('[role=group] button')?.textContent).toContain('Send back');
  } finally {
    await card.unmount();
  }
});
