import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { installDom, type Mounted } from '../test-dom.test-helpers';
import { ClampedSummary } from './ClampedSummary';

// The toggle shows on measured overflow and is clicked, which static markup cannot reach.
const { dom, mount } = await installDom();

/*
 * happy-dom lays nothing out, so every height reads 0. The paragraph's heights are stubbed on
 * the prototype before mounting, since the summary measures as it mounts.
 */
const proto = dom.HTMLParagraphElement.prototype as object;
const heights = ['scrollHeight', 'clientHeight'].map(
  key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const
);
function stubHeights(scroll: number, client: number): void {
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scroll });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => client });
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  for (const [key, descriptor] of heights)
    if (descriptor) Object.defineProperty(proto, key, descriptor);
    else Reflect.deleteProperty(proto, key);
});

async function summary(): Promise<HTMLElement> {
  mounted = await mount(<ClampedSummary text="A long summary of the factory." lines={2} />);
  return mounted.container;
}

describe('the clamped summary', () => {
  test('text that overflows gets More, which opens it, and Less closes it again', async () => {
    stubHeights(240, 66);
    const page = await summary();
    const toggle = (): HTMLButtonElement => page.querySelector('button') as HTMLButtonElement;
    expect(toggle().textContent).toBe('More');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle().click());
    expect(toggle().textContent).toBe('Less');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle().click());
    expect(toggle().textContent).toBe('More');
  });
});
