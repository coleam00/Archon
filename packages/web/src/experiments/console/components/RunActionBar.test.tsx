import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { RunActionBar } from './RunActionBar';
import { PendingInputBanner } from './PendingInputBanner';
import { toRun } from '../primitives/run';

function buttonClick(node: ReactNode, label: string): (() => void) | undefined {
  let click: (() => void) | undefined;
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button' && child.props.children === label) click = child.props.onClick;
    else if (typeof child.type === 'function' && child.props.onClick !== undefined) {
      const props = child.props;
      const button = child.type as (buttonProps: typeof props) => ReactNode;
      click ??= buttonClick(button(props), label);
    } else click ??= buttonClick(child.props.children, label);
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
      kind: 'attention',
      runId: 'needs-resume',
      nodeId: 'hold',
      message: 'Rotate then resume',
      occurrence: 'legacy:hold',
      form: 'message',
      options: [],
    },
  });
  let click: (() => void) | undefined;
  function Probe(): ReactElement | null {
    const element = RunActionBar({ run });
    click = buttonClick(element, 'Resume');
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

test('a provider-limit wait in the banner shows its reset, Resume and Abandon, and no gate controls', () => {
  const resumeAt = '2026-10-12T05:00:00.000Z';
  const run = toRun({
    id: 'limited',
    workflow_name: 'rotate',
    codebase_id: null,
    status: 'paused',
    started_at: '2026-10-12T00:00:00.000Z',
    attention: { kind: 'usage_limit', runId: 'limited', nodeId: 'implement', resumeAt },
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PendingInputBanner runs={[run]} showProject={false} onDismiss={() => undefined} />
    </MemoryRouter>
  );
  expect(html).toContain('implement');
  expect(html).toContain(new Date(resumeAt).toLocaleString());
  expect(html).toContain('Abandon');
  expect(html).toContain('Resume');
  expect(html).not.toContain('Continue');
});

test.each([
  ['unreachable', true],
  ['unknown', false],
  ['reachable', false],
] as const)('a running run whose owner is %s offers Abandon: %s', (observation, offered) => {
  const run = toRun({
    id: 'orphan',
    workflow_name: 'implement',
    codebase_id: null,
    status: 'running',
    started_at: '2026-10-12T00:00:00.000Z',
    owner_observation: observation,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunActionBar run={run} />
    </MemoryRouter>
  );
  expect(html.includes('Abandon')).toBe(offered);
  expect(html).toContain('Cancel');
});

test.each(['running', 'failed', 'paused'] as const)(
  'Abandon dispatches one abandon request for a %s run',
  async status => {
    const run = toRun({
      id: 'abandon-run',
      workflow_name: 'implement',
      codebase_id: null,
      status,
      started_at: '2026-10-12T00:00:00.000Z',
      owner_observation: 'unreachable',
      ...(status === 'paused'
        ? {
            attention: {
              kind: 'usage_limit',
              runId: 'abandon-run',
              nodeId: 'implement',
              resumeAt: '2026-10-12T05:00:00.000Z',
            },
          }
        : {}),
    });
    let click: (() => void) | undefined;
    function Probe(): ReactElement | null {
      const element = RunActionBar({ run });
      click = buttonClick(element, 'Abandon');
      return element;
    }
    renderToStaticMarkup(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>
    );
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
      expect(requests).toEqual([
        { path: '/api/workflows/runs/abandon-run/abandon', method: 'POST' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);
