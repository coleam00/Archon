import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom } from '../../test-dom.test-helpers';
import type { ReferenceChip } from '../lib/prompt-references';
import { StepPrompt } from './StepPrompt';

// The fold is clicked, which static markup cannot do.
const { dom, mount } = await installDom();

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
  test.each([
    // Each reference in prose is a chip, a repeated one each time.
    [
      'in prose',
      'Land $INPUTS.item under $INPUTS.land_policy, then $INPUTS.item.',
      ['item', 'land policy', 'item'],
    ],
    // A reference inside real code stays code.
    [
      'inside real code',
      'Read `$INPUTS.land_on/policy.md`.\n\n```sh\necho $INPUTS.item\n```\n',
      [],
    ],
    // A prefix pair is two chips, and a path reference is never cut short.
    [
      'a prefix pair',
      'Read $INPUTS.land_on, $INPUTS.land_policy, $build.output and $build.output.proposed.',
      ['land on', 'land policy', 'Build output', 'Build output, proposed'],
    ],
  ])('a reference %s', (_case, prompt, expected) => {
    const root = rendered(prompt, CHIPS);
    expect(chipsIn(root)).toEqual(expected);
    expect(root.textContent).not.toContain('.proposed');
  });

  test('a chip has the token on hover, and the prose keeps its shape', () => {
    const root = rendered(
      '# Land it\n\nLand $INPUTS.item.\n\n```sh\necho $INPUTS.item\n```\n',
      CHIPS
    );
    const chip = root.querySelector('[data-ref-label="item"]');
    expect(chip?.getAttribute('title')).toBe('$INPUTS.item');
    expect(chip?.getAttribute('data-ref-kind')).toBe('input');
    expect(root.querySelector('h1')?.textContent).toBe('Land it');
    expect(root.querySelector('p')?.textContent).not.toContain('$INPUTS');
  });
});

describe('the fold', () => {
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, index) => `Line ${(index + 1).toString()}.`).join('\n\n');

  test('a long prompt is clipped to its first screen until "Show the whole prompt"', async () => {
    const { container, unmount } = await mount(<StepPrompt prompt={lines(60)} chips={[]} />);
    const fold = (): Element | null => container.querySelector('[data-prompt-fold]');
    const toggle = (): HTMLButtonElement | null => container.querySelector('button');
    expect(fold()?.getAttribute('data-prompt-fold')).toBe('folded');
    expect(toggle()?.textContent).toBe('Show the whole prompt');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle()?.click());
    expect(fold()?.getAttribute('data-prompt-fold')).toBe('open');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.textContent).toBe('Show less');
    await unmount();
  });
});
