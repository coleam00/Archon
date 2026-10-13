import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { RunActionBar } from './RunActionBar';
import { PendingInputBanner } from './PendingInputBanner';
import { toRun } from '../primitives/run';

function resumeClick(node: ReactNode): (() => void) | undefined {
  let click: (() => void) | undefined;
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button' && child.props.children === 'Resume') click = child.props.onClick;
    else click ??= resumeClick(child.props.children);
  });
  return click;
}

test('the attention banner Resume action dispatches one resume request and no gate decision', async () => {
  const run = toRun({
    id: 'needs-resume',
    workflow_name: 'rotate',
    codebase_id: null,
    status: 'paused',
    started_at: '2026-10-12T00:00:00.000Z',
    attention: {
      kind: 'action_required',
      runId: 'needs-resume',
      nodeId: 'hold',
      message: 'Rotate then resume',
      occurrence: 'wait:now',
    },
  });
  let click: (() => void) | undefined;
  function Probe(): ReactElement | null {
    const element = RunActionBar({ run });
    click = resumeClick(element);
    return element;
  }
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PendingInputBanner runs={[run]} showProject={false} onDismiss={() => undefined} />
      <Probe />
    </MemoryRouter>
  );
  expect(html).toContain('data-pending-run-id="needs-resume"');
  expect(click).toBeDefined();
  const originalFetch = globalThis.fetch;
  const requests: { path: string; method: string | undefined }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path:
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        method: init?.method,
      });
      return Response.json({ success: true });
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    click?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toEqual([{ path: '/api/workflows/runs/needs-resume/resume', method: 'POST' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
