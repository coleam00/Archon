import { afterEach, expect, mock, test } from 'bun:test';
import { createElement, isValidElement, type ReactNode } from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { toRun } from './console/primitives/run';

interface ButtonProps {
  'data-keymap-approve'?: boolean;
  onClick?: () => void;
}

const { jsx, jsxs } = runtime;
let approve: (() => void) | undefined;
function capture<T extends ReactNode>(element: T): T {
  if (
    isValidElement<ButtonProps>(element) &&
    element.type === 'button' &&
    element.props['data-keymap-approve']
  ) {
    approve = element.props.onClick;
  }
  return element;
}

// Capture the rendered control while keeping React hooks and the response skill real.
// This file runs in its own package-test group because Bun module mocks persist.
mock.module('react/jsx-runtime', () => ({
  ...runtime,
  jsx: (...args: Parameters<typeof jsx>): ReturnType<typeof jsx> => capture(jsx(...args)),
  jsxs: (...args: Parameters<typeof jsxs>): ReturnType<typeof jsxs> => capture(jsxs(...args)),
}));
const approvalPanelComponent = (await import('./console/components/ApprovalPanel')).ApprovalPanel;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  approve = undefined;
});

for (const pauseId of ['pause-before', 'pause-after']) {
  test(`clicking approval sends the displayed ${pauseId} through the real response skill`, () => {
    const request = mock((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json({ success: true }))
    );
    globalThis.fetch = Object.assign(request, { preconnect: originalFetch.preconnect });
    const run = toRun({
      id: 'review-run',
      workflow_name: 'review',
      codebase_id: null,
      status: 'paused',
      started_at: '2026-10-05T10:00:00Z',
      metadata: {
        approval: {
          nodeId: 'review-gate',
          pauseId,
          message: 'Review the plan',
          decisions: [{ id: 'approve' }, { id: 'revise' }, { id: 'escalate' }],
          decisionsAuthored: true,
        },
      },
    });

    renderToStaticMarkup(createElement(approvalPanelComponent, { run }));
    if (approve === undefined) throw new Error('Approval control was not rendered');
    approve();

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('/api/workflows/runs/review-run/respond');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON response body');
    expect(JSON.parse(init.body)).toEqual({
      decision: 'approve',
      expectedGate: { nodeId: 'review-gate', pauseId },
    });
  });
}
