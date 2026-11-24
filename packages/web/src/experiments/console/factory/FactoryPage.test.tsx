import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryViews, FactoryWorkflow } from '../skills/factory';
import type { AttentionQueue } from '../skills/runs';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import type { FactoryItem } from '../skills/factory';
import { FIXTURE_NOW, needsShaping, PAGE, VIEW } from './lib/board.test-fixtures';
import { shippedListed } from './item-detail.test-fixtures';
import { askItem } from '../lib/needs-you.test-fixtures';

// The board sets aside items idle past a line counted from now, so the fixtures' items are read
// at the time they were copied, never at the day the test runs.
beforeAll(() => {
  setSystemTime(FIXTURE_NOW);
});
afterAll(() => {
  setSystemTime();
});

const ID = 'cb-1';

afterEach(() => {
  invalidate('factory-views');
  invalidate('factory-workflow');
  invalidate('project');
  invalidate('runs');
  invalidate('factory-items');
});

const quiet: AttentionQueue = { items: [], runs: [], degraded: [] };

const withView: FactoryViews = {
  views: [
    {
      pack: 'acme/kit',
      packKey: 'acme.kit',
      runNames: { deliver: 'acme/kit:deliver' },
      source: 'project-file',
      path: '/repo/.archon/packs/acme.kit.factory-view.json',
      declaration: {
        version: 1,
        pack: 'acme/kit',
        title: 'Kit factory',
        summary: 'Issues come in; changes go out.',
        stages: [
          {
            id: 'build',
            label: 'Build',
            blurb: 'Builds.',
            group: 'build',
            workflows: ['deliver'],
            nodes: ['build__build', 'rounds.fix'],
          },
          {
            id: 'checks',
            label: 'Checks',
            blurb: 'Checks the change.',
            group: 'check',
            workflows: ['deliver'],
            nodes: ['rounds.review__review'],
          },
          { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
        ],
        placement: {},
        endings: {},
        landed: { stage: 'build' },
        map: { cards: [], arrows: [] },
      },
    },
  ],
  errors: [],
};
const none: FactoryViews = { views: [], errors: [] };
/** The declaration this repository ships, over the real items the board's fixtures hold. */
const shipped: FactoryViews = {
  views: [
    {
      ...shippedListed,
      declaration: VIEW,
    },
  ],
  errors: [],
};

/**
 * Every link marked as the current page, as `href label`, whatever its other attributes:
 * the project tab and the sub-navigation entry. Styling is not what is asserted.
 */
const currentLinks = (html: string): string[] =>
  [...html.matchAll(/<a\s([^>]*)>(.*?)<\/a>/g)]
    .filter(([, attributes]) => / aria-current="page"|^aria-current="page"/.test(attributes ?? ''))
    .map(([, attributes, body]) => {
      const href = /href="([^"]*)"/.exec(attributes ?? '')?.[1] ?? '';
      return `${href} ${(body ?? '').replace(/<[^>]*>/g, '')}`;
    });

function render(
  path: string | { pathname: string; state: unknown },
  listing: FactoryViews,
  attention: AttentionQueue = quiet,
  items: FactoryItem[] = []
): string {
  set(K.factoryViews(ID), listing);
  set(K.projectAttention(ID), attention);
  set(K.factoryWorkflow(ID, 'deliver'), deliverJson as FactoryWorkflow);
  set(K.factoryItems(ID), { items, members: {} });
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
}

/** Six open asks, newest last: more than the Overview shows. */
const sixAsks: AttentionQueue = {
  items: Array.from({ length: 6 }, (_, i) =>
    askItem({
      ref: `ask:${i.toString()}`,
      message: `Question ${i.toString()}?`,
      pausedAt: `2026-11-1${i.toString()}T09:00:00.000Z`,
    })
  ),
  runs: [],
  degraded: [],
};
/** How many ask cards are drawn. */
const askCards = (html: string): number => html.split('data-ask=').length - 1;
const text = (html: string): string => html.replace(/<[^>]*>/g, '');
const SUMMARY = 'Issues come in; changes go out.';
/** The Factory sub-navigation's links, as `href label`. */
const subNav = (html: string): string[] => {
  const start = html.indexOf('aria-label="Factory"');
  expect(start).toBeGreaterThan(-1);
  return [
    ...html
      .slice(start, html.indexOf('</nav>', start))
      .matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g),
  ].map(([, href, body]) => `${href ?? ''} ${text(body ?? '')}`);
};
const SUB_NAV = [
  `/console/p/${ID}/factory Overview`,
  `/console/p/${ID}/factory/board Board`,
  `/console/p/${ID}/factory/settings Settings`,
];

describe('the Factory section', () => {
  test('its tab follows Metrics when a view applies, and is absent when none does', () => {
    const html = render(`/console/p/${ID}/needs-you`, withView);
    expect(html.match(/>(Needs you|Runs|Chat|Metrics|Factory)</g)).toEqual([
      '>Needs you<',
      '>Runs<',
      '>Chat<',
      '>Metrics<',
      '>Factory<',
    ]);
    expect(html).toContain(`href="/console/p/${ID}/factory"`);
    expect(render(`/console/p/${ID}/needs-you`, none)).not.toContain('Factory');
  });

  test('a busy Overview: title, summary, one count of what waits, the newest three asks, then the map', () => {
    const html = render(`/console/p/${ID}/factory`, withView, sixAsks, [
      needsShaping('9s', ['Which?']),
    ]);
    expect(html).toContain('Kit factory');
    expect(html).toContain(SUMMARY);
    expect(currentLinks(html)).toEqual([
      `/console/p/${ID}/factory Factory`,
      `/console/p/${ID}/factory Overview`,
    ]);
    expect(subNav(html)).toEqual(SUB_NAV);
    // Six asks and an item waiting on you: the tab and the tile read the same count.
    expect([...html.matchAll(/aria-label="(\d+) waiting"/g)].map(match => match[1])).toEqual(['7']);
    const strip = html.slice(html.indexOf('aria-label="Numbers"'), html.indexOf('</ul>'));
    expect(text(strip)).toContain('need you7');
    expect(askCards(html)).toBe(3);
    for (const i of [5, 4, 3]) expect(html).toContain(`Question ${i.toString()}?`);
    expect(html).toContain('4 more on Needs you');
    expect(html).toContain('>Recommended<');
    // Compact: no answer is sent from the Overview, and Needs you is the project's tab.
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain(`href="/console/p/${ID}/factory/needs-you"`);
    const needsYou = html.indexOf('aria-label="Needs you"');
    expect(needsYou).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="The map"')).toBeGreaterThan(needsYou);
  });

  test('a quiet Overview says an item waits on you, and its numbers count the board', () => {
    const waiting = render(`/console/p/${ID}/factory`, withView, quiet, [
      needsShaping('9s', ['Which?']),
    ]);
    expect(waiting).toContain('1 item waits for you on Needs you');
    expect(waiting).not.toContain('more on Needs you');

    const html = render(`/console/p/${ID}/factory`, shipped, quiet, PAGE.items);
    const strip = text(
      html.slice(html.indexOf('aria-label="Numbers"'), html.indexOf('aria-label="The map"'))
    );
    // Item 3's merge state is unknown: counted only in M.
    for (const tile of ['in flight4', 'need you0', 'merged3 of 8', 'median to merged'])
      expect(strip).toContain(tile);
  });

  test('Needs you is the project tab, listing every ask, without the Factory frame', () => {
    const html = render(`/console/p/${ID}/needs-you`, withView, sixAsks);
    expect(currentLinks(html)).toEqual([`/console/p/${ID}/needs-you Needs you6`]);
    expect(html).toContain('6 things need you');
    expect(askCards(html)).toBe(6);
    expect(html).not.toContain(SUMMARY);
  });

  test('the board sits under Board, its columns the declared stages, the title without the summary', () => {
    const html = render(`/console/p/${ID}/factory/board`, withView, sixAsks);
    expect(currentLinks(html)).toEqual([
      `/console/p/${ID}/factory Factory`,
      `/console/p/${ID}/factory/board Board`,
    ]);
    expect(subNav(html)).toEqual(SUB_NAV);
    expect(html).toContain('aria-label="Build"');
    expect(html).toContain('Kit factory');
    expect(html).not.toContain(SUMMARY);
  });

  test('a step page leads back to the stage it was opened from, else the stage that works it', () => {
    const own = render(`/console/p/${ID}/factory/steps/deliver/rounds.fix`, withView);
    expect(own).toContain('From command fix');
    expect(own).toContain(`href="/console/p/${ID}/factory?stage=build"`);
    expect(own).not.toContain(SUMMARY);
    const opened = render(
      {
        pathname: `/console/p/${ID}/factory/steps/deliver/rounds.fix`,
        state: { fromStage: 'checks' },
      },
      withView
    );
    expect(opened).toContain(`href="/console/p/${ID}/factory?stage=checks"`);
    expect(opened).toContain('Back to Checks');
  });

  test('a broken project file shows its path and error; a project no view applies to, an empty state', () => {
    const broken = render(`/console/p/${ID}/factory`, {
      views: [],
      errors: [
        { pack: 'acme.kit', source: 'project-file', path: '/repo/x.json', error: 'is invalid' },
      ],
    });
    expect(broken).toContain('/repo/x.json');
    expect(broken).toContain('is invalid');
    expect(broken).not.toContain('No factory view applies');
    expect(render(`/console/p/${ID}/factory`, none)).toContain(
      'No factory view applies to this project'
    );
  });
});
