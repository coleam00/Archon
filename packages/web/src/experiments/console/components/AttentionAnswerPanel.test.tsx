import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AttentionAnswerPanel } from './AttentionAnswerPanel';
import { RunActionBar } from './RunActionBar';
import { toRun, type Run } from '../primitives/run';

// A DOM for the one test that types into the panel; restored after this file.
const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
// React tracks a text box's value through the prototype setter, so typing goes through it.
const setTextAreaValue = Object.getOwnPropertyDescriptor(
  dom.HTMLTextAreaElement.prototype,
  'value'
)?.set;

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** The click handler of the button labelled `label`, rendering function components on the way. */
function buttonClick(node: ReactNode, label: string): (() => void) | undefined {
  let click: (() => void) | undefined;
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button' && child.props.children === label) click = child.props.onClick;
    else if (typeof child.type === 'function')
      click ??= buttonClick((child.type as (props: unknown) => ReactNode)(child.props), label);
    else click ??= buttonClick(child.props.children, label);
  });
  return click;
}

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

test('a select wait is answered with the chosen option at its occurrence, never resumed', async () => {
  let click: (() => void) | undefined;
  let resume: (() => void) | undefined;
  function Probe(): ReactElement | null {
    const panel = AttentionAnswerPanel({ run, attention });
    click = buttonClick(panel, 'Use main');
    resume = buttonClick(RunActionBar({ run }), 'Resume');
    return panel;
  }
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Probe />
    </MemoryRouter>
  );
  expect(html).toContain('use-dev');
  expect(resume).toBeUndefined();
  const originalFetch = globalThis.fetch;
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path:
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ success: true });
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    click?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toEqual([
      {
        path: '/api/workflows/runs/ask-run/answer',
        body: { occurrence: 'pause-1', choose: ['use-main'] },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the reserved 'other' option cannot be chosen without text", () => {
  const html = renderToStaticMarkup(
    <AttentionAnswerPanel
      run={run}
      attention={{
        ...attention,
        other: true,
        options: [...attention.options, { id: 'other', label: 'Other' }],
      }}
    />
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Other<\/button>/);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Use main<\/button>/);
});

test('a message wait can be answered only while its text has a non-blank character', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const message = { ...attention, form: 'message' as const, options: [] };
  const answerButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find(button => button.textContent === 'Answer');
  const type = async (value: string): Promise<void> => {
    const box = container.querySelector('textarea');
    if (!box) throw new Error('Answer text box was not rendered');
    await act(async () => {
      setTextAreaValue?.call(box, value);
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<AttentionAnswerPanel run={run} attention={message} />));
    expect(answerButton()?.disabled).toBe(true);
    await type('   ');
    expect(answerButton()?.disabled).toBe(true);
    await type('1, 3');
    expect(answerButton()?.disabled).toBe(false);
    await type('');
    expect(answerButton()?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('the recommendation and what each option does are shown before the choices', () => {
  const recommended = {
    ...attention,
    options: [
      { id: 'use-main', label: 'Use main', does: 'Rebases the branch onto main.' },
      { id: 'use-dev' },
    ],
    recommendation: { option: 'use-main', why: 'Main has the fix.', confidence: 'medium' },
  } as const satisfies NonNullable<Run['attention']>;
  const html = renderToStaticMarkup(
    <AttentionAnswerPanel run={{ ...run, attention: recommended }} attention={recommended} />
  );
  expect(html).toContain('Recommended: Use main');
  expect(html).toContain('(medium confidence)');
  expect(html).toContain('Main has the fix.');
  expect(html).toContain('Rebases the branch onto main.');
  expect(html).toContain('Use main (recommended)');
});
