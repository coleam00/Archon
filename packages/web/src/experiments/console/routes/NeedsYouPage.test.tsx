import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes } from 'react-router';
import { shippedListed } from '../factory/item-detail.test-fixtures';
import { askItem, gateItem, usageLimitItem } from '../lib/needs-you.test-fixtures';
import type { FactoryItem, FactoryViews } from '../skills/factory';
import type { ItemRead } from '../skills/items';
import type { AttentionQueue } from '../skills/runs';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from './project-routes';

const ID = 'cb-needs';

afterEach(() => {
  invalidate('factory-views');
  invalidate('factory-items');
  invalidate('runs');
  invalidate('project');
});

const none: FactoryViews = { views: [], errors: [] };
const withView: FactoryViews = { views: [shippedListed], errors: [] };
const seven = { id: 'item-7', projectKey: 'acme', key: '#7' };
const nine = { id: 'item-9', projectKey: 'acme', key: '#9' };

/** Three asks on two items, a gate no item holds, and a usage limit, which needs no one. */
const busy: AttentionQueue = {
  items: [
    askItem({ ref: 'ask:7a', item: seven, pausedAt: '2026-11-16T09:00:00.000Z' }),
    askItem({
      ref: 'ask:9',
      item: nine,
      message: 'Split it?',
      pausedAt: '2026-11-15T09:00:00.000Z',
    }),
    askItem({
      ref: 'ask:7b',
      item: seven,
      message: 'Rebase?',
      pausedAt: '2026-11-14T09:00:00.000Z',
    }),
    gateItem({ ref: 'gate:1' }),
    usageLimitItem(),
  ],
  runs: [],
  degraded: [],
};

const windowRead = (items: FactoryItem[]): ItemRead[] =>
  items.map(({ progress: _progress, ...read }) => read);

function render(listing: FactoryViews, queue: AttentionQueue, items: FactoryItem[] = []): string {
  set(K.factoryViews(ID), listing);
  set(K.projectAttention(ID), queue);
  set(K.factoryItems(ID), { items, members: {} });
  set(K.projectItems(ID), windowRead(items));
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/console/p/${ID}/needs-you`]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
}
const words = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('the Needs you tab', () => {
  test('on a project with no factory view: first, before Runs, with its count; no Factory tab', () => {
    const html = render(none, busy);
    expect(html.match(/>(Needs you|Runs|Chat|Metrics|Factory)</g)).toEqual([
      '>Needs you<',
      '>Runs<',
      '>Chat<',
      '>Metrics<',
    ]);
    expect(html).toContain('aria-label="4 waiting"');
  });

  test('the heading counts what the badge counts, and says how many items they are on', () => {
    const text = words(render(none, busy));
    // Three asks and a gate; the usage limit retries by itself.
    expect(text).toContain('4 things need you');
    // Two items, and the gate's run, which no item holds: a run, not an item.
    expect(text).toContain('on 2 items and 1 run');
  });

  test('a wait on a run no item holds: counted and named as a run, its workflow named once', () => {
    const html = render(none, { items: [gateItem({ ref: 'gate:1' })], runs: [], degraded: [] });
    const text = words(html);
    expect(text).toContain('1 thing needs you');
    expect(text).toContain('on 1 run');
    expect(text).not.toContain('item');
    // The group's own text, after its opening tag: the heading names the run, the card its workflow.
    const start = html.indexOf('aria-label="Asks on Run run-gate"');
    expect(start).toBeGreaterThan(-1);
    const group = words(html.slice(html.indexOf('>', start) + 1));
    expect(group.match(/deliver/g)).toHaveLength(1);
    expect(group).toContain('Run run-gate');
  });

  test("an item's asks sit together under it, newest first; without a view an item links to its run", () => {
    const html = render(none, busy);
    const groups = [...html.matchAll(/aria-label="Asks on ([^"]+)"/g)].map(match => match[1]);
    expect(groups).toEqual(['#7', '#9', 'Run run-gate']);
    const seventh = html.slice(html.indexOf('Asks on #7'), html.indexOf('Asks on #9'));
    expect(seventh.indexOf('Which base should the change target?')).toBeLessThan(
      seventh.indexOf('Rebase?')
    );
    expect(html).not.toContain('/factory/items/');
    expect(html).toContain(`href="/console/p/${ID}/r/run-gate"`);
  });

  test('with a factory view an item links to its factory page', () => {
    expect(render(withView, busy)).toContain(
      `href="/console/p/${ID}/factory/items/${encodeURIComponent('#7')}"`
    );
  });

  test('a paused run that could not be read is said, above the cards', () => {
    const html = render(none, {
      ...busy,
      degraded: [{ type: 'degraded', reason: 'run_unreadable', runId: 'r-x' }],
    } as AttentionQueue);
    expect(words(html)).toContain(
      'One paused run could not be read, so what it waits on is not listed.'
    );
  });
});
