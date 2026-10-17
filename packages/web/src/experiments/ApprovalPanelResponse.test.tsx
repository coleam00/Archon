import { afterEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { createElement, isValidElement, type ReactNode } from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { toRun } from './console/primitives/run';

interface ButtonProps {
  children?: ReactNode;
  'data-keymap-approve'?: boolean;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
}

const { jsx, jsxs } = runtime;
const states: unknown[] = [];
let cursor = 0;
const controls: ButtonProps[] = [];
const react = { ...React };
mock.module('react', () => ({
  ...react,
  useState: <T,>(initial: T): [T, (value: T) => void] => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [
      states[index] as T,
      value => {
        states[index] = value;
      },
    ];
  },
}));
let approve: (() => void) | undefined;
function capture<T extends ReactNode>(element: T): T {
  if (
    isValidElement<ButtonProps>(element) &&
    element.type === 'button' &&
    element.props['data-keymap-approve']
  ) {
    approve = element.props.onClick;
  }
  if (
    isValidElement<ButtonProps>(element) &&
    (element.type === 'button' || element.type === 'textarea')
  ) {
    controls.push(element.props);
  }
  return element;
}

// Capture controls and retain form state between renders; the response skill remains real.
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
  states.length = 0;
  controls.length = 0;
  cursor = 0;
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

for (const pauseId of ['pause-before', 'pause-after']) {
  test(`confirming a custom decision sends accept and the displayed ${pauseId}`, () => {
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
          message: 'Choose a direction',
          decisionsAuthored: true,
          decisions: [
            { id: 'accept', label: 'Accept plan' },
            { id: 'revise', label: 'Revise plan' },
          ],
        },
      },
    });
    const render = (): string => {
      cursor = 0;
      controls.length = 0;
      return renderToStaticMarkup(createElement(approvalPanelComponent, { run }));
    };
    render();
    const accept = controls.find(control => control.title === 'Accept plan this run');
    if (!accept?.onClick) throw new Error('Accept control was not rendered');
    accept.onClick();
    expect(render()).toContain('Accept plan — text');
    const feedback = controls.find(control => control.onChange !== undefined);
    if (!feedback?.onChange) throw new Error('Feedback control was not rendered');
    feedback.onChange({ target: { value: 'Use this plan' } });
    expect(render()).toContain('Accept plan run');
    const confirm = controls.find(
      control =>
        control.disabled === false &&
        React.Children.toArray(control.children).includes('Accept plan run')
    );
    if (!confirm?.onClick) throw new Error('Enabled confirmation was not rendered');
    confirm.onClick();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('/api/workflows/runs/review-run/respond');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string') throw new Error('Expected JSON response body');
    expect(JSON.parse(init.body)).toEqual({
      decision: 'accept',
      text: 'Use this plan',
      expectedGate: { nodeId: 'review-gate', pauseId },
    });
  });
}
