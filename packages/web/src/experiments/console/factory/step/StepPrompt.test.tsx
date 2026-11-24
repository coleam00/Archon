import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReferenceChip } from '../lib/prompt-references';
import { StepPrompt } from './StepPrompt';

// The fold is clicked, which static markup cannot do.
const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function rendered(prompt: string, chips: ReferenceChip[] = []): HTMLElement {
  const root = dom.document.createElement('div');
  root.innerHTML = renderToStaticMarkup(<StepPrompt prompt={prompt} chips={chips} />);
  return root as unknown as HTMLElement;
}

const CHIPS: ReferenceChip[] = [
  { token: '$INPUTS.item', kind: 'input', label: 'item' },
  { token: '$INPUTS.land_on', kind: 'input', label: 'land on' },
  { token: '$INPUTS.land_policy', kind: 'input', label: 'land policy' },
  { token: '$build.output', kind: 'output', label: 'Build output' },
  { token: '$build.output.proposed', kind: 'output', label: 'Build output, proposed' },
];

const chipsIn = (root: HTMLElement): (string | null)[] =>
  [...root.querySelectorAll('[data-ref-label]')].map(chip => chip.getAttribute('data-ref-label'));

describe('reference chips', () => {
  test('each reference in prose is a named chip, a repeated one each time, the token on hover', () => {
    const root = rendered(
      '# Land it\n\nLand $INPUTS.item under $INPUTS.land_policy, then report $INPUTS.item.',
      CHIPS
    );
    expect(chipsIn(root)).toEqual(['item', 'land policy', 'item']);
    const chip = root.querySelector('[data-ref-label="item"]');
    expect(chip?.getAttribute('title')).toBe('$INPUTS.item');
    expect(chip?.getAttribute('data-ref-kind')).toBe('input');
    // The heading stays a heading; no raw token is left in the prose.
    expect(root.querySelector('h1')?.textContent).toBe('Land it');
    expect(root.querySelector('p')?.textContent).not.toContain('$INPUTS');
  });

  test('a code span that is exactly one reference is its chip, the token on hover', () => {
    const root = rendered('Merge onto `$INPUTS.land_on` for $INPUTS.item.', CHIPS);
    expect(chipsIn(root)).toEqual(['land on', 'item']);
    expect(root.querySelector('[data-ref-label="land on"]')?.getAttribute('title')).toBe(
      '$INPUTS.land_on'
    );
    expect(root.querySelector('p code')).toBeNull();
  });

  test('a reference inside real code stays code: a longer span and a code block', () => {
    const root = rendered(
      'Read `$INPUTS.land_on/policy.md` first.\n\n```sh\necho $INPUTS.item\n```\n',
      CHIPS
    );
    expect(root.querySelector('p code')?.textContent).toBe('$INPUTS.land_on/policy.md');
    expect(root.querySelector('pre code')?.textContent).toContain('echo $INPUTS.item');
    expect(chipsIn(root)).toEqual([]);
  });

  test('a prefix pair is two chips, and a path reference is never cut short', () => {
    const root = rendered(
      'Read $INPUTS.land_on and $INPUTS.land_policy, $build.output and $build.output.proposed.',
      CHIPS
    );
    expect(chipsIn(root)).toEqual([
      'land on',
      'land policy',
      'Build output',
      'Build output, proposed',
    ]);
    expect(root.textContent).not.toContain('.proposed');
  });
});

describe('the fold', () => {
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, index) => `Line ${(index + 1).toString()}.`).join('\n\n');

  test('a short prompt is not folded and has no toggle', () => {
    const root = rendered(lines(10));
    expect(root.querySelector('[data-prompt-fold]')).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });

  test('a long prompt is clipped to its first screen until "Show the whole prompt"', async () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement;
    dom.document.body.appendChild(container as never);
    const root = createRoot(container);
    await act(async () => {
      root.render(<StepPrompt prompt={lines(60)} chips={[]} />);
    });
    const fold = (): Element | null => container.querySelector('[data-prompt-fold]');
    const toggle = (): HTMLButtonElement | null => container.querySelector('button');
    expect(fold()?.getAttribute('data-prompt-fold')).toBe('folded');
    expect(fold()?.classList.contains('max-h-150')).toBe(true);
    expect(toggle()?.textContent).toBe('Show the whole prompt');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle()?.click();
    });
    expect(fold()?.getAttribute('data-prompt-fold')).toBe('open');
    expect(fold()?.classList.contains('max-h-150')).toBe(false);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.textContent).toBe('Show less');
    await act(async () => {
      root.unmount();
    });
  });
});
