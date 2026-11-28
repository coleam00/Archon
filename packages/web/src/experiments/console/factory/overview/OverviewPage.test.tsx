import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { overviewFlow } from '../lib/overview-flow';
import { layoutOverview } from '../lib/overview-layout';
import type { OverviewDeclaration, OverviewView } from '../lib/overview-nav';
import { OVERVIEW } from '../lib/overview.test-fixtures';
import { installDom } from '../test-dom.test-helpers';
import { OverviewBody } from './OverviewPage';

// Opening a view and going back up need clicks, which static markup cannot reach.
const { dom, mount: mountTree } = await installDom();

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

async function mount(
  at = '/console/p/cb-1/factory/how-it-works',
  overview: OverviewDeclaration = OVERVIEW
): Promise<HTMLElement> {
  const mounted = await mountTree(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="/console/p/:projectId/factory/how-it-works"
          element={<OverviewBody overview={overview} />}
        />
      </Routes>
    </MemoryRouter>
  );
  unmount = mounted.unmount;
  return mounted.container;
}

const cards = (within: ParentNode): string[] =>
  [...within.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card') ?? '');
const crumbs = (within: ParentNode): string =>
  [...within.querySelectorAll('nav[aria-label="Breadcrumb"] li')]
    .map(li => li.textContent?.replace('›', '').trim())
    .join(' › ');

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click');
  await act(async () => (element as HTMLElement).click());
}

const button = (within: ParentNode, text: string): Element | undefined =>
  [...within.querySelectorAll('button')].find(b => b.textContent?.includes(text));

describe('the factory overview', () => {
  test('opens at the root with its cards, caption and every view listed with its count and line', async () => {
    const page = await mount();
    expect(cards(page)).toEqual(['in', 'make', 'check']);
    expect(crumbs(page)).toBe('How it works');
    expect(page.textContent).toContain('Work comes in, is made, and is checked.');
    const listed = [...page.querySelectorAll('aside[aria-label="Views"] li')].map(li => {
      const line = li.querySelector('[data-line]')?.textContent ?? '';
      return [li.textContent?.replace(line, '').trim(), line];
    });
    // A drill-down's line is the text of the card that opens it.
    expect(listed).toEqual([
      ['How it works3', 'The whole factory, start to end'],
      ['Make2', 'What Make does.'],
      ['Test it1', 'What Test it does.'],
      ['Check1', 'What Check does.'],
    ]);
    // Only a card that opens a view is a button.
    expect(page.querySelector('button[data-card="in"]')).toBeNull();
    // Up one level has nowhere to go from the root.
    expect((button(page, 'Up one level') as HTMLButtonElement).disabled).toBe(true);
  });

  test('a card opens its drill-down, and the breadcrumb leads back to the root', async () => {
    const page = await mount();
    await click(page.querySelector('[data-card="make"]'));
    expect(cards(page)).toEqual(['write', 'test']);
    expect(crumbs(page)).toBe('How it works › Make');
    expect(page.textContent).toContain('How a change is made.');

    await click(page.querySelector('[data-card="test"]'));
    expect(crumbs(page)).toBe('How it works › Make › Test it');
    await click(button(page, 'Up one level'));
    expect(crumbs(page)).toBe('How it works › Make');

    await click(
      button(page.querySelector('nav[aria-label="Breadcrumb"]') as Element, 'How it works')
    );
    expect(cards(page)).toEqual(['in', 'make', 'check']);
  });

  test('the sidebar opens any view; an unknown ?view= opens the root and says so', async () => {
    const page = await mount('/console/p/cb-1/factory/how-it-works?view=gone');
    expect(cards(page)).toEqual(['in', 'make', 'check']);
    // It names the view it could not find rather than silently showing the root.
    expect(page.textContent).toContain('"gone"');
    await click(button(page.querySelector('aside') as Element, 'Test it'));
    expect(cards(page)).toEqual(['run']);
    expect(crumbs(page)).toBe('How it works › Make › Test it');
  });

  test('full screen draws over the console, opens views inside, and Esc closes it', async () => {
    const page = await mount();
    await click(button(page, 'Full screen'));
    const overlay = document.body.querySelector('[role="dialog"]');
    expect(overlay?.getAttribute('aria-label')).toBe('How it works, full screen');
    expect(cards(overlay as Element)).toEqual(['in', 'make', 'check']);
    // Views open inside it too.
    await click(overlay?.querySelector('[data-card="check"]'));
    expect(cards(document.body.querySelector('[role="dialog"]') as Element)).toEqual(['read']);

    await act(async () => {
      window.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event);
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(cards(page)).toEqual(['read']);
  });
});

describe('the flow on the root view', () => {
  const svgProto = dom.SVGSVGElement.prototype as unknown as {
    pauseAnimations: () => void;
    unpauseAnimations: () => void;
  };
  const original = {
    pause: svgProto.pauseAnimations,
    unpause: svgProto.unpauseAnimations,
  };
  let calls: string[] = [];
  beforeEach(() => {
    calls = [];
    svgProto.pauseAnimations = function (this: Element) {
      calls.push(`pause:${this.isConnected ? 'mounted' : 'detached'}`);
    };
    svgProto.unpauseAnimations = () => calls.push('unpause');
  });
  afterEach(() => {
    svgProto.pauseAnimations = original.pause;
    svgProto.unpauseAnimations = original.unpause;
    dom.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
  });

  const dots = (within: ParentNode): string[] =>
    [...within.querySelectorAll('[data-flow-move]')].map(
      dot => dot.getAttribute('data-flow-move') ?? ''
    );

  test('dots run the forward line; Pause flow stops it, also across full screen', async () => {
    const page = await mount();
    const flow = overviewFlow(
      OVERVIEW.views.top as OverviewView,
      layoutOverview(OVERVIEW.views.top as OverviewView)
    );
    expect(dots(page)).toEqual(flow?.moves.map(move => `${move.from}->${move.to}`) ?? []);

    await click(button(page, 'Pause flow'));
    expect(button(page, 'Play flow')?.getAttribute('aria-pressed')).toBe('true');
    expect(calls.at(-1)).toBe('pause:mounted');
    // A pause holds across full screen, where the map mounts anew.
    calls = [];
    await click(button(page, 'Full screen'));
    const overlay = document.body.querySelector('[role="dialog"]') as Element;
    expect(button(overlay, 'Play flow')?.getAttribute('aria-pressed')).toBe('true');
    expect(overlay.querySelector('svg[data-flow]')?.getAttribute('data-flow')).toBe('paused');
    expect(calls).toEqual(['pause:mounted']);
    await click(button(overlay, 'Exit full screen'));
    await click(button(page, 'Play flow'));
    expect(button(page, 'Pause flow')?.getAttribute('aria-pressed')).toBe('false');
    expect(calls.at(-1)).toBe('unpause');
  });

  test('under reduced motion the root has no dots and no control', async () => {
    dom.happyDOM.settings.device.prefersReducedMotion = 'reduce';
    const still = await mount();
    expect(cards(still)).toEqual(['in', 'make', 'check']);
    expect(dots(still)).toEqual([]);
    expect(button(still, 'Pause flow')).toBeUndefined();
  });
});
