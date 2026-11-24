import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ItemAsksSection, type AnsweredAsk } from './ItemAsksSection';
import type { ItemAsk } from '../primitives/run';

const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const item = { id: 'item-1', projectKey: 'acme/widgets', key: 'issues/7' };
const ask = (ref: string, question: string): ItemAsk => ({
  kind: 'attention',
  ref,
  project: { key: 'acme/widgets', codebaseId: 'cb-1', name: 'widgets' },
  item,
  revision: 1,
  labels: {},
  pausedAt: null,
  message: question,
  context: `Context for ${question}`,
  form: 'select',
  options: [
    { id: 'keep', does: 'Keeps the flag.', cost: 'One more flag.' },
    { id: 'drop', does: 'Drops the flag.', cost: 'Old configs break.' },
  ],
  recommendation: { option: 'keep', why: 'Nothing needs it gone.' },
  askedIn: { runId: 'run-plan', workflow: 'plan' },
});
const first = ask('ask:a1', 'Keep the flag?');
const second = ask('ask:a2', 'Rename the column?');

/** Holds what the runs page holds: the listed asks and the ones answered here. */
function Harness({
  listed,
  refusals = {},
}: {
  listed: ItemAsk[];
  refusals?: Record<string, string>;
}): ReactElement {
  const [answered, setAnswered] = useState<AnsweredAsk[]>([]);
  return (
    <MemoryRouter>
      <ItemAsksSection
        asks={listed}
        answered={answered}
        answerRefusals={refusals}
        itemIds={new Set(listed.map(open => open.item?.id ?? ''))}
        showProject={false}
        onAnswered={record => {
          setAnswered(prev => [...prev, record]);
        }}
        onDismissItem={() => undefined}
      />
    </MemoryRouter>
  );
}

async function mount(): Promise<{
  container: HTMLElement;
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: async element => act(async () => root.render(element)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttons = (scope: Element): HTMLButtonElement[] => [...scope.querySelectorAll('button')];

test('two asks on an item show their question, context, options with cost, and the recommendation', async () => {
  const view = await mount();
  try {
    await view.render(<Harness listed={[first, second]} />);
    const text = view.container.textContent;
    for (const expected of [
      'issues/7',
      'Keep the flag?',
      'Context for Keep the flag?',
      'Rename the column?',
      'Keeps the flag.',
      'Cost: Old configs break.',
      'Recommended',
      'Nothing needs it gone.',
    ])
      expect(text).toContain(expected);
    expect(view.container.querySelectorAll('[data-item-asks]')).toHaveLength(1);
    // Each ask draws its own tiles: the recommended one first, marked green.
    const tiles = buttons(view.container).map(button => button.getAttribute('data-recommended'));
    expect(tiles).toEqual(['true', null, 'true', null]);
    expect(buttons(view.container).map(button => button.textContent?.startsWith('Keep'))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  } finally {
    await view.unmount();
  }
});

test('answering posts by ref, shows the answer, and the item stops waiting once the list is empty', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ref: 'ask:a1', action: 'answer', unchanged: false, settled: false });
    },
    { preconnect: originalFetch.preconnect }
  );
  const view = await mount();
  try {
    await view.render(<Harness listed={[first, second]} />);
    const keep = view.container.querySelector<HTMLButtonElement>('[data-ask-ref="ask:a1"] button');
    if (keep === null) throw new Error('No answer button for ask:a1');
    // A tile only picks; Confirm sends.
    await act(async () => {
      keep.click();
    });
    expect(requests).toEqual([]);
    const confirm = buttons(view.container.querySelector('[data-ask-ref="ask:a1"]')!).find(
      button => button.textContent === 'Confirm'
    );
    if (confirm === undefined) throw new Error('No Confirm button for ask:a1');
    await act(async () => {
      confirm.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(requests).toEqual([
      { path: '/api/attention/answer', body: { ref: 'ask:a1', choose: ['keep'] } },
    ]);
    const answered = view.container.querySelector('[data-ask-ref="ask:a1"]');
    expect(answered?.textContent).toContain('Answered: keep');
    expect(buttons(answered!)).toHaveLength(0);
    expect(view.container.textContent).not.toContain('no longer waits');

    // The refetched list no longer holds the item: nothing open is left on it.
    await view.render(<Harness listed={[]} />);
    expect(view.container.textContent).toContain('This item no longer waits on anyone.');
  } finally {
    globalThis.fetch = originalFetch;
    await view.unmount();
  }
});

test('an ask the caller may not answer shows the reason and no answer controls', async () => {
  const view = await mount();
  try {
    await view.render(
      <Harness listed={[first]} refusals={{ 'ask:a1': 'Only the user who started it.' }} />
    );
    expect(view.container.textContent).toContain(
      "You can't answer this: Only the user who started it."
    );
    expect(view.container.textContent).toContain('Keeps the flag.');
    // The options show, but none can be chosen and there is no Confirm.
    expect(buttons(view.container).every(button => button.disabled)).toBe(true);
    expect(buttons(view.container).map(button => button.textContent)).not.toContain('Confirm');
    expect(view.container.querySelector('textarea')).toBeNull();
  } finally {
    await view.unmount();
  }
});

test('an ask with no recommendation says so and marks no option recommended', async () => {
  const { recommendation: _none, ...unrecommended } = ask('ask:a3', 'Which way?');
  const view = await mount();
  try {
    await view.render(<Harness listed={[unrecommended]} />);
    expect(view.container.textContent).toContain('No recommendation. Choose an option.');
    expect(view.container.textContent).not.toContain('Recommended:');
    // The fork's tiles carry each option's description and cost after its label.
    const tiles = buttons(view.container);
    expect(tiles.map(button => button.textContent?.startsWith('Keep'))).toEqual([true, false]);
    expect(tiles.map(button => button.textContent?.startsWith('Drop'))).toEqual([false, true]);
    expect(tiles.map(button => button.getAttribute('data-recommended'))).toEqual([null, null]);
  } finally {
    await view.unmount();
  }
});

test('the item header reads `issue-7` and `7` as #7, the group keeping the key', async () => {
  for (const key of ['issue-7', '7']) {
    const view = await mount();
    try {
      const keyed = { ...first, item: { ...item, key } };
      await view.render(<Harness listed={[keyed]} />);
      const group = view.container.querySelector('[data-item-asks]');
      expect(group?.querySelector('.font-mono')?.textContent).toBe('#7');
      expect(view.container.textContent).not.toContain('issue-7');
    } finally {
      await view.unmount();
    }
  }
});
