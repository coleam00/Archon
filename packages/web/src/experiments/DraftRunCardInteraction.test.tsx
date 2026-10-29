import { afterEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { invalidate, set } from './console/store/cache';
import { K } from './console/store/keys';
import { toWorkflow } from './console/primitives/workflow';
import { WorkflowPicker } from './console/components/WorkflowPicker';

const states: unknown[] = [];
let cursor = 0;
let renderingCard = false;
const react = { ...React };
// Retain the card's state across server renders; children keep their native hooks.
// The isolated package-test group prevents this React mock leaking to other tests.
mock.module('react', () => ({
  ...react,
  useState: <T,>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] => {
    if (!renderingCard) return react.useState(initial);
    const index = cursor++;
    if (!(index in states))
      states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      states[index] as T,
      value => {
        states[index] =
          typeof value === 'function' ? (value as (previous: T) => T)(states[index] as T) : value;
      },
    ];
  },
}));
const { DraftRunCard } = await import('./console/components/DraftRunCard');

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const projectCwd = '/draft-refusal-test';

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  states.length = 0;
  invalidate(K.workflows(projectCwd));
});

function elements(node: ReactNode): ReactElement[] {
  const result: ReactElement[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    result.push(child, ...elements(child.props.children));
  });
  return result;
}

function draft() {
  let tree: ReactNode;
  function Probe(): ReactElement {
    cursor = 0;
    renderingCard = true;
    try {
      const card = DraftRunCard({ projectId: 'p1', projectCwd });
      tree = card;
      return card;
    } finally {
      renderingCard = false;
    }
  }
  const render = (): string =>
    renderToStaticMarkup(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>
    );
  const button = (label: string): (() => void) => {
    for (const element of elements(tree)) {
      if (
        isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(
          element
        ) &&
        element.type === 'button' &&
        renderToStaticMarkup(element).includes(label)
      ) {
        expect(element.props.disabled).not.toBe(true);
        if (element.props.onClick) return element.props.onClick;
      }
    }
    throw new Error(`Missing button: ${label}`);
  };
  render();
  button('Start a new run')();
  render();
  const picker = elements(tree).find(element => element.type === WorkflowPicker);
  if (!isValidElement<React.ComponentProps<typeof WorkflowPicker>>(picker))
    throw new Error('Missing workflow picker');
  picker.props.onChange('review-block');
  render();
  return {
    render,
    button,
    attach: () => {
      const input = elements(tree).find(
        element =>
          element.type === 'input' &&
          isValidElement<{ type?: string }>(element) &&
          element.props.type === 'file'
      );
      if (
        !isValidElement<{
          onChange: (event: { target: { files: File[]; value: string } }) => void;
        }>(input)
      )
        throw new Error('Missing file input');
      input.props.onChange({ target: { files: [new File(['brief'], 'brief.txt')], value: '' } });
      expect(render()).toContain('brief.txt');
    },
  };
}

for (const attached of [false, true]) {
  for (const refusal of ['long', 'empty launch', 'empty conversation', 'proxy'] as const) {
    test(`draft displays ${refusal} refusal and stays open (attached: ${String(attached)})`, async () => {
      const message = `Launch refused: ${'credential preflight detail; '.repeat(12)}TAIL-MUST-BE-VISIBLE`;
      const html = `<img src=x onerror="alert(1)">${'Bad gateway '.repeat(40)}`;
      const requests: { url: string; body: RequestInit['body'] }[] = [];
      globalThis.window = { location: { origin: 'http://localhost' } } as Window &
        typeof globalThis;
      set(K.workflows(projectCwd), {
        workflows: [toWorkflow({ workflow: { name: 'review-block' }, source: 'project' })],
        recommended: [],
      });
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          requests.push({ url, body: init?.body });
          if (url === '/api/conversations' && refusal !== 'empty conversation')
            return Response.json({ conversationId: 'web-test' });
          return refusal === 'long'
            ? Response.json({ error: message }, { status: 409 })
            : new Response(refusal === 'proxy' ? html : '', { status: 502 });
        },
        { preconnect: originalFetch.preconnect }
      );

      const card = draft();
      if (attached) card.attach();
      card.button('Start run')();
      await new Promise(resolve => setTimeout(resolve, 0));
      const rendered = card.render();
      expect(rendered).toContain('Cancel draft');
      card.button('Start run');
      if (attached) expect(rendered).toContain('brief.txt');
      if (refusal === 'long') {
        expect(rendered).toContain(message);
        expect(rendered).toContain('TAIL-MUST-BE-VISIBLE');
      } else if (refusal === 'proxy') {
        expect(rendered).toContain('&lt;img');
        expect(rendered).not.toContain('<img');
        expect(rendered).toContain(
          `${html.slice(0, 200).replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}...`
        );
      } else {
        expect(rendered).toContain('API error 502');
        expect(rendered).toContain(
          refusal === 'empty conversation'
            ? '/api/conversations'
            : '/api/workflows/review-block/run'
        );
      }
      expect(requests).toHaveLength(refusal === 'empty conversation' ? 1 : 2);
      if (refusal !== 'empty conversation')
        expect(requests[1]?.body instanceof FormData).toBe(attached);
    });
  }
}
