import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AttentionAnswerForm, AttentionAnswerPanel } from './AttentionAnswerPanel';
import { RunActionBar } from './RunActionBar';
import { toRun, type Run } from '../primitives/run';

// Choosing a tile re-renders the form, which static markup cannot reach.
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
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const attention = {
  kind: 'attention',
  runId: 'ask-run',
  nodeId: 'ask',
  message: 'Which base?',
  occurrence: 'pause-1',
  form: 'select',
  options: [{ id: 'use-main', label: 'Use main' }, { id: 'use-dev' }],
} as const satisfies NonNullable<Run['attention']>;
const run = toRun({
  id: 'ask-run',
  workflow_name: 'pick-base',
  codebase_id: null,
  status: 'paused',
  started_at: '2026-10-14T00:00:00.000Z',
  attention,
});

async function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter>{element}</MemoryRouter>));
  const button = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find(candidate =>
      candidate.textContent?.startsWith(label)
    );
    if (found === undefined) throw new Error(`No button "${label}"`);
    return found;
  };
  const click = async (label: string): Promise<void> => {
    await act(async () => {
      button(label).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  return {
    container,
    button,
    click,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('a select wait: a tile chooses, Confirm answers at the occurrence, never resumed', async () => {
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ success: true });
    },
    { preconnect: originalFetch.preconnect }
  );
  // The run's own controls offer no resume for an answerable wait.
  expect(
    renderToStaticMarkup(
      <MemoryRouter>
        <RunActionBar run={run} />
      </MemoryRouter>
    )
  ).not.toContain('Resume');
  const form = await mount(<AttentionAnswerPanel run={run} attention={attention} />);
  try {
    // An option with no label reads as its id humanised, never raw.
    expect(form.container.textContent).toContain('Use dev');
    expect(form.container.textContent).not.toContain('use-dev');
    await form.click('Use main');
    expect(requests).toEqual([]);
    expect(form.container.textContent).toContain('Answer: Use main');
    await form.click('Confirm');
    expect(requests).toEqual([
      {
        path: '/api/workflows/runs/ask-run/answer',
        body: { occurrence: 'pause-1', choose: ['use-main'] },
      },
    ]);
  } finally {
    await form.unmount();
  }
});

test("the reserved 'other' option reads Something else and cannot be confirmed without text", async () => {
  const withOther = {
    ...attention,
    other: true,
    options: [...attention.options, { id: 'other', label: 'Other' }],
  } as const satisfies NonNullable<Run['attention']>;
  const form = await mount(<AttentionAnswerForm wait={withOther} submit={async () => {}} />);
  try {
    expect(form.container.textContent).toContain('Something elseWrite your own answer');
    await form.click('Something else');
    expect(form.button('Confirm').disabled).toBe(true);
    const box = form.container.querySelector('textarea');
    if (box === null) throw new Error('No textarea opened');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(box) as object,
        'value'
      )?.set;
      setter?.call(box, 'Rebase on release instead.');
      box.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
    });
    expect(form.button('Confirm').disabled).toBe(false);
    // Choosing an ordinary option instead needs no text.
    await form.click('Cancel');
    await form.click('Use main');
    expect(form.button('Confirm').disabled).toBe(false);
  } finally {
    await form.unmount();
  }
});

test('the recommended tile comes first, marked, with what each does and costs, and why under the tiles', () => {
  const html = renderToStaticMarkup(
    <AttentionAnswerForm
      wait={{
        form: 'select',
        options: [
          {
            id: 'use-main',
            label: 'Use main',
            does: 'Rebases onto main.',
            cost: 'Drops dev fixes.',
          },
          { id: 'use-dev', label: 'Use dev', does: 'Rebases onto dev.', cost: 'One more rebase.' },
        ],
        recommendation: {
          option: 'use-dev',
          why: 'Dev is the working base.',
          confidence: 'medium',
        },
      }}
      submit={async () => {}}
    />
  );
  // A text node, not the tile's hover title that repeats its words.
  const at = (text: string): number => {
    const index = html.indexOf(`>${text}<`);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };
  expect(at('Use dev')).toBeLessThan(at('Recommended'));
  expect(at('Recommended')).toBeLessThan(at('Rebases onto dev.'));
  expect(at('Cost: One more rebase.')).toBeLessThan(at('Use main'));
  expect(at('Use main')).toBeLessThan(at('Rebases onto main.'));
  expect(at('Rebases onto main.')).toBeLessThan(at('Cost: Drops dev fixes.'));
  expect(at('Cost: Drops dev fixes.')).toBeLessThan(
    at('Medium confidence. Dev is the working base.')
  );
  // Nothing is chosen until a tile is: no confirm row yet.
  expect(html).not.toContain('Confirm');
});

test('a message wait has no tiles and opens with the textarea', () => {
  const html = renderToStaticMarkup(
    <AttentionAnswerForm wait={{ form: 'message', options: [] }} submit={async () => {}} />
  );
  expect(html).not.toContain('aria-pressed');
  expect(html).toContain('<textarea');
  expect(html).toContain('Answer in words');
});

test('a message wait can be confirmed only while its text has a non-blank character', async () => {
  const form = await mount(
    <AttentionAnswerForm wait={{ form: 'message', options: [] }} submit={async () => {}} />
  );
  const type = async (value: string): Promise<void> => {
    const box = form.container.querySelector('textarea');
    if (box === null) throw new Error('No textarea opened');
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box) as object, 'value')?.set?.call(
        box,
        value
      );
      box.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
    });
  };
  try {
    expect(form.button('Confirm').disabled).toBe(true);
    await type('   ');
    expect(form.button('Confirm').disabled).toBe(true);
    await type('1, 3');
    expect(form.button('Confirm').disabled).toBe(false);
    await type('');
    expect(form.button('Confirm').disabled).toBe(true);
  } finally {
    await form.unmount();
  }
});
