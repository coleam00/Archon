import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AttentionAnswerPanel } from './AttentionAnswerPanel';
import { RunActionBar } from './RunActionBar';
import { toRun, type Run } from '../primitives/run';

function buttonClick(node: ReactNode, label: string): (() => void) | undefined {
  let click: (() => void) | undefined;
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button' && child.props.children === label) click = child.props.onClick;
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
