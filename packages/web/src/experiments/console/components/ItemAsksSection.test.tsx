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
  compact,
}: {
  listed: ItemAsk[];
  refusals?: Record<string, string>;
  compact?: { openAt: string };
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
        compact={compact}
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
      'Recommended: keep',
      'Nothing needs it gone.',
    ])
      expect(text).toContain(expected);
    expect(view.container.querySelectorAll('[data-item-asks]')).toHaveLength(1);
    const labels = buttons(view.container).map(button => button.textContent);
    expect(labels).toEqual(['keep (recommended)', 'drop', 'keep (recommended)', 'drop']);
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
    await act(async () => {
      keep.click();
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
    expect(buttons(view.container)).toHaveLength(0);
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
    expect(buttons(view.container).map(button => button.textContent)).toEqual(['keep', 'drop']);
  } finally {
    await view.unmount();
  }
});

test('the compact form is one row an ask: the recommended option answers it and Open leads to the full ask', async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ ref: 'ask:a1', action: 'answer', unchanged: false, settled: false });
    },
    { preconnect: originalFetch.preconnect }
  );
  const view = await mount();
  try {
    const open = { ...second, recommendation: undefined };
    await view.render(<Harness listed={[first, open]} compact={{ openAt: '/board' }} />);
    const rows = [...view.container.querySelectorAll('[data-ask-ref]')];
    expect(rows).toHaveLength(2);
    // The full form's options and costs are not in a row.
    expect(view.container.textContent).not.toContain('Old configs break.');
    expect(rows.map(row => buttons(row).length)).toEqual([1, 0]);
    expect(
      rows.map(row => row.querySelector('a')?.getAttribute('href')?.startsWith('/board#'))
    ).toEqual([true, true]);
    const [recommended] = buttons(rows[0]!);
    await act(async () => {
      recommended?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(requests).toEqual([{ ref: 'ask:a1', choose: ['keep'] }]);
  } finally {
    globalThis.fetch = originalFetch;
    await view.unmount();
  }
});
