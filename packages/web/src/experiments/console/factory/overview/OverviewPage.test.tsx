import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router';
import { overviewFlow } from '../lib/overview-flow';
import { layoutOverview } from '../lib/overview-layout';
import type { OverviewDeclaration, OverviewView } from '../lib/overview-nav';
import { OVERVIEW } from '../lib/overview.test-fixtures';
import { KINDS } from './overview-kinds';
import { OverviewBody } from './OverviewPage';

// Opening a view and going back up need clicks, which static markup cannot reach.
const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

async function mount(
  at = '/console/p/cb-1/factory/how-it-works',
  overview: OverviewDeclaration = OVERVIEW
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route
            path="/console/p/:projectId/factory/how-it-works"
            element={<OverviewBody overview={overview} />}
          />
        </Routes>
      </MemoryRouter>
    )
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
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
    // On a phone, the open view's line sits under the select.
    expect(page.querySelector('aside label')?.textContent).toContain(
      'The whole factory, start to end'
    );
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

  test('on a phone the views are a select showing the open view, and choosing one opens it', async () => {
    const page = await mount();
    const select = page.querySelector('aside select') as HTMLSelectElement;
    expect(select.value).toBe('top');
    const nb = (n: number): string => String.fromCharCode(160).repeat(n);
    expect([...select.options].map(o => o.textContent)).toEqual([
      'How it works (3)',
      `${nb(2)}Make (2)`,
      `${nb(4)}Test it (1)`,
      `${nb(2)}Check (1)`,
    ]);
    await act(async () => {
      select.value = 'check';
      select.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
    });
    expect(cards(page)).toEqual(['read']);
    expect(crumbs(page)).toBe('How it works › Check');
    expect((page.querySelector('aside select') as HTMLSelectElement).value).toBe('check');
  });

  test('full screen draws over the console until Exit or Esc, the legend docked bottom left', async () => {
    const page = await mount();
    await click(button(page, 'Full screen'));
    const overlay = document.body.querySelector('[role="dialog"]');
    expect(overlay?.getAttribute('aria-label')).toBe('How it works, full screen');
    expect(cards(overlay as Element)).toEqual(['in', 'make', 'check']);
    // The map has the screen: no views sidebar or caption, the legend in its bottom-left corner.
    expect(overlay?.querySelector('aside')).toBeNull();
    expect(overlay?.textContent).not.toContain('Work comes in, is made, and is checked.');
    const legend = overlay?.querySelector('ul[aria-label="Legend"]')?.parentElement;
    expect(legend?.className).toContain('bottom-4');
    expect(legend?.className).toContain('left-4');
    // Views open inside it too.
    await click(overlay?.querySelector('[data-card="check"]'));
    expect(cards(document.body.querySelector('[role="dialog"]') as Element)).toEqual(['read']);

    await act(async () => {
      window.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event);
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(cards(page)).toEqual(['read']);

    await click(button(page, 'Full screen'));
    await click(
      button(document.body.querySelector('[role="dialog"]') as Element, 'Exit full screen')
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test('the shipped overview says Merged, never Landed, and its legend explains the shadow line', async () => {
    const shipped = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          '../../../../../../../.archon/packs/Wirasm.archon-software-factory.factory-overview.json'
        ),
        'utf8'
      )
    ) as OverviewDeclaration;
    const page = await mount(undefined, shipped);
    expect(page.textContent).toContain('Merged');
    expect(page.textContent).toContain('Ready to merge');
    expect(page.textContent).not.toMatch(/Landed|Ready to land|may it land/);
    expect(page.querySelector('ul[aria-label="Legend"]')?.textContent).toContain(
      'would do it, does nothing yet'
    );
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

  test('dots run the forward line on one SMIL timeline, and Pause flow stops it', async () => {
    const page = await mount();
    const flow = overviewFlow(
      OVERVIEW.views.top as OverviewView,
      layoutOverview(OVERVIEW.views.top as OverviewView)
    );
    expect(dots(page)).toEqual(flow?.moves.map(move => `${move.from}->${move.to}`) ?? []);
    for (const motion of page.querySelectorAll('animateMotion')) {
      // Paced (the default) would ignore the key times that hold a dot still outside its leg.
      expect(motion.getAttribute('calcMode')).toBe('linear');
      expect(motion.getAttribute('keyTimes')?.split(';')).toHaveLength(4);
    }
    expect(page.querySelector('svg[data-flow]')?.getAttribute('class')).toContain(
      'motion-reduce:hidden'
    );

    await click(button(page, 'Pause flow'));
    expect(button(page, 'Play flow')?.getAttribute('aria-pressed')).toBe('true');
    expect(calls.at(-1)).toBe('pause:mounted');
    await click(button(page, 'Play flow'));
    expect(button(page, 'Pause flow')?.getAttribute('aria-pressed')).toBe('false');
    expect(calls.at(-1)).toBe('unpause');
  });

  test('each dot takes the colour of the card it travels to, on a shadow line the shadow colour', async () => {
    const top = OVERVIEW.views.top as OverviewView;
    const kindOf = new Map(top.cards.map(card => [card.id, card.kind]));
    const fills = (within: ParentNode): string[] =>
      [...within.querySelectorAll('[data-flow-move]')].map(dot => dot.getAttribute('fill') ?? '');
    const page = await mount();
    const moves = dots(page);
    expect(moves.length).toBeGreaterThan(0);
    expect(fills(page)).toEqual(
      moves.map(move => KINDS[kindOf.get(move.split('->')[1] ?? '') ?? 'stage'].color)
    );
    // The dot and its halo move as one: two circles in the moving group.
    for (const dot of page.querySelectorAll('[data-flow-move]'))
      expect(dot.querySelectorAll('circle')).toHaveLength(2);
    // Every card is drawn in the card identity.
    for (const card of page.querySelectorAll('[data-card]'))
      expect(card.className).toContain('factory-card');
    expect(page.querySelector('[role="group"]')?.className).toContain('factory-canvas');
    await unmount?.();

    const shadowed = await mount('/console/p/cb-1/factory/how-it-works', {
      ...OVERVIEW,
      views: {
        ...OVERVIEW.views,
        top: {
          ...top,
          edges: top.edges.map(edge =>
            edge.from === 'in' && edge.to === 'make' ? { ...edge, shadow: true } : edge
          ),
        },
      },
    });
    const into = [...shadowed.querySelectorAll('[data-flow-move="in->make"]')];
    expect(into.map(dot => dot.getAttribute('fill'))).toEqual(['var(--node-opaque)']);
  });

  test('a pause holds across full screen, where the map mounts anew', async () => {
    const page = await mount();
    await click(button(page, 'Pause flow'));
    calls = [];
    await click(button(page, 'Full screen'));
    const overlay = document.body.querySelector('[role="dialog"]') as Element;
    expect(button(overlay, 'Play flow')?.getAttribute('aria-pressed')).toBe('true');
    expect(overlay.querySelector('svg[data-flow]')?.getAttribute('data-flow')).toBe('paused');
    expect(calls).toEqual(['pause:mounted']);
    await click(button(overlay, 'Exit full screen'));
  });

  test('no dots and no control under reduced motion', async () => {
    dom.happyDOM.settings.device.prefersReducedMotion = 'reduce';
    const page = await mount();
    expect(cards(page)).toEqual(['in', 'make', 'check']);
    expect(dots(page)).toEqual([]);
    expect(button(page, 'Pause flow')).toBeUndefined();
  });

  test('a drill-down stays still, even one with a line the flow could run', async () => {
    // The drill-down gets an input card feeding its first stage, as every shipped drill-down
    // has, so only the root-only gate keeps its dots off.
    const make = OVERVIEW.views.make as OverviewView;
    const animatable: OverviewView = {
      ...make,
      cards: [
        { ...(make.cards[0] as OverviewView['cards'][number]), id: 'brief', kind: 'input' },
        ...make.cards.map(card => ({ ...card, col: card.col + 1 })),
      ],
      edges: [{ from: 'brief', to: 'write', kind: 'feeds' }, ...make.edges],
    };
    expect(overviewFlow(animatable, layoutOverview(animatable))).toBeDefined();
    const page = await mount('/console/p/cb-1/factory/how-it-works?view=make', {
      ...OVERVIEW,
      views: { ...OVERVIEW.views, make: animatable },
    });
    expect(cards(page)).toEqual(['brief', 'write', 'test']);
    expect(dots(page)).toEqual([]);
    expect(button(page, 'Pause flow')).toBeUndefined();
  });
});
