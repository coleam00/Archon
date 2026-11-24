import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { ReactElement } from 'react';
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
import { askItem, usageLimitItem } from '../lib/needs-you.test-fixtures';
import { EMPTY_STAGE_LIVE } from './lib/map-live';
import { StageView, useStageTab } from './stage/StageView';

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
  invalidate(K.factoryPacks);
  invalidate('factory-workflow');
  invalidate('project');
  invalidate('runs');
  invalidate('factory-items');
});

const asking: AttentionQueue = { items: [askItem()], runs: [], degraded: [] };
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
  set(K.factoryItems(ID), { items: [], members: {} });
  set(K.factoryWorkflow(ID, 'deliver'), deliverJson as FactoryWorkflow);
  set(K.factoryItems(ID), { items: items, members: {} });
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
}

/** A stage on the tab it opens on, as its modal draws it; the modal portals, which static markup cannot reach. */
function renderStage(stageId: string): string {
  render(`/console/p/${ID}/factory`, withView);
  const view = withView.views[0]!.declaration;
  const stage = view.stages.find(candidate => candidate.id === stageId)!;
  function Stage(): ReactElement {
    const [tab, setTab] = useStageTab(stage);
    return (
      <StageView
        projectId={ID}
        view={view}
        stage={stage}
        live={EMPTY_STAGE_LIVE}
        tab={tab}
        onTab={setTab}
        frame={({ head, body }) => (
          <>
            {head}
            {body}
          </>
        )}
      />
    );
  }
  return renderToStaticMarkup(
    <MemoryRouter>
      <Stage />
    </MemoryRouter>
  );
}

describe('the Factory tab', () => {
  test('follows Metrics when a view applies to the project', () => {
    const html = render(`/console/p/${ID}/needs-you`, withView);
    expect(html.match(/>(Needs you|Runs|Chat|Metrics|Factory)</g)).toEqual([
      '>Needs you<',
      '>Runs<',
      '>Chat<',
      '>Metrics<',
      '>Factory<',
    ]);
    expect(html).toContain(`href="/console/p/${ID}/factory"`);
  });

  test('is absent when no view applies', () => {
    expect(render(`/console/p/${ID}/needs-you`, none)).not.toContain('Factory');
  });
});

describe('the Overview', () => {
  test("shows the view's title, summary and sub-navigation", () => {
    const html = render(`/console/p/${ID}/factory`, withView);
    expect(html).toContain('Kit factory');
    expect(html).toContain('Issues come in; changes go out.');
    expect(currentLinks(html)).toEqual([
      `/console/p/${ID}/factory Factory`,
      `/console/p/${ID}/factory Overview`,
    ]);
    expect(html).toContain(`href="/console/p/${ID}/factory/board"`);
    // Needs you is the project's tab, which links there; the sub-navigation and the tiles do not.
    expect(html).not.toContain(`href="/console/p/${ID}/factory/needs-you"`);
    expect(html.split(`href="/console/p/${ID}/needs-you"`)).toHaveLength(2);
  });

  test('the tab and the Overview number read one count: asks and waits', () => {
    // Two asks on one item (#7) and a usage limit: 2 asks and waits, 3 queue items, 1 item.
    const queue: AttentionQueue = {
      items: [askItem({ ref: 'ask:a' }), askItem({ ref: 'ask:b' }), usageLimitItem()],
      runs: [],
      degraded: [],
    };
    const html = render(`/console/p/${ID}/factory`, withView, queue);
    const badges = [...html.matchAll(/aria-label="(\d+) waiting"/g)].map(match => match[1]);
    expect(badges).toEqual(['2']);
    const strip = html.slice(html.indexOf('aria-label="Numbers"'), html.indexOf('</ul>'));
    expect(strip.replace(/<[^>]*>/g, '')).toContain('need you2');
  });

  test('the tab, the Overview number and its "more" line count an item waiting on you too', () => {
    const queue: AttentionQueue = {
      items: [askItem({ ref: 'ask:a' }), askItem({ ref: 'ask:b' })],
      runs: [],
      degraded: [],
    };
    const html = render(`/console/p/${ID}/factory`, withView, queue, [
      needsShaping('9s', ['Which?']),
    ]);
    const badges = [...html.matchAll(/aria-label="(\d+) waiting"/g)].map(match => match[1]);
    expect(badges).toEqual(['3']);
    const strip = html.slice(html.indexOf('aria-label="Numbers"'), html.indexOf('</ul>'));
    expect(strip.replace(/<[^>]*>/g, '')).toContain('need you3');
    // Two asks shown, the item waiting on you on Needs you.
    expect(html).toContain('1 more on Needs you');
  });

  test('with no ask open, the Overview says an item waits on you, not "more"', () => {
    const html = render(`/console/p/${ID}/factory`, withView, quiet, [
      needsShaping('9s', ['Which?']),
    ]);
    expect(html).toContain('1 item waits for you on Needs you');
    expect(html).not.toContain('more on Needs you');
  });

  test('shows the summary only on the Overview; other pages show the title alone', () => {
    const summary = 'Issues come in; changes go out.';
    const overview = render(`/console/p/${ID}/factory`, withView);
    // A two-line lead, so the numbers start in the first screen.
    const paragraph = overview
      .match(/<p[^>]*class="([^"]*)"[^>]*>([^<]*)<\/p>/g)
      ?.find(p => p.includes(summary));
    expect(paragraph).toContain('line-clamp-2');
    for (const path of ['/board', '/steps/deliver/rounds.fix']) {
      const html = render(`/console/p/${ID}/factory${path}`, withView);
      expect(html).toContain('Kit factory');
      expect(html).not.toContain(summary);
    }
  });

  test('the numbers strip counts the board, each number a plain figure', () => {
    const html = render(`/console/p/${ID}/factory`, shipped, quiet, PAGE.items);
    // The strip alone: the map's cards below are links drawn the same way.
    const strip = html.slice(
      html.indexOf('aria-label="Numbers"'),
      html.indexOf('aria-label="The map"')
    );
    const tiles = [
      ...strip.matchAll(
        /<li data-tile="([^"]*)"><div[^>]*>.*?<\/span><span[^>]*>(?:<span[^>]*>)?([^<]*)</g
      ),
    ].map(([, label, value]) => `${value ?? ''} ${label ?? ''}`);
    expect(tiles).toEqual([
      // Item 3's merge state is unknown: counted only in M.
      '4 in flight',
      '0 need you',
      expect.stringMatching(/^\d+ merged today$/),
      '3 of 8 merged',
      expect.stringMatching(/ median to merged$/),
      // Its own read, not answered in a static render: a skeleton, no figure.
      ' found by the factory',
    ]);
    // The median says what it means on hover; no tile says where it goes.
    expect([...strip.matchAll(/<div title="([^"]*)"/g)].map(([, title]) => title)).toEqual([
      'The median time from an item&#x27;s first run to its change merging',
    ]);
    // Above the map.
    expect(html.indexOf('aria-label="Numbers"')).toBeLessThan(html.indexOf('aria-label="The map"'));
  });

  test('lists what needs you on the Overview: the question and the recommended tile, opening on Needs you', () => {
    const html = render(`/console/p/${ID}/factory`, withView, asking);
    expect(html).toContain('Which base should the change target?');
    expect(html).toContain('Use dev');
    expect(html).toContain('>Recommended<');
    expect(html).toContain('High confidence. Dev is the working base.');
    expect(html).toContain(`href="/console/p/${ID}/needs-you?ask=ask%3A1"`);
    // Compact: no answer is sent from the Overview.
    expect(html).not.toContain('aria-pressed');
  });

  test('the map follows what needs you', () => {
    const html = render(`/console/p/${ID}/factory`, withView, asking);
    const needsYou = html.indexOf('aria-label="Needs you"');
    expect(needsYou).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="The map"')).toBeGreaterThan(needsYou);
  });

  test('the sub-navigation is Overview, Board and Settings, on each page', () => {
    // The view's pack is listed and an ask waits: what used to add How it works and a
    // counted Needs you link. Both live elsewhere now (the sidebar, the project tab); the
    // project's Settings live here (owner change of 2026-11-23).
    set(K.factoryPacks, {
      packs: [
        {
          pack: 'acme.kit',
          key: 'acme.kit',
          overview: null,
          readFrom: null,
          projects: [],
          errors: [],
        },
      ],
      errors: [],
      unreadProjects: [],
    });
    const subNav = (html: string): string[] => {
      const start = html.indexOf('aria-label="Factory"');
      expect(start).toBeGreaterThan(-1);
      return [
        ...html
          .slice(start, html.indexOf('</nav>', start))
          .matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g),
      ].map(([, href, body]) => `${href ?? ''} ${(body ?? '').replace(/<[^>]*>/g, '')}`);
    };
    const links = [
      `/console/p/${ID}/factory Overview`,
      `/console/p/${ID}/factory/board Board`,
      `/console/p/${ID}/factory/settings Settings`,
    ];
    const overview = render(`/console/p/${ID}/factory`, withView, asking);
    expect(subNav(overview)).toEqual(links);
    expect(overview).not.toContain('/console/factory/acme.kit');
    const board = render(`/console/p/${ID}/factory/board`, withView, asking);
    expect(subNav(board)).toEqual(links);
    expect(currentLinks(board)).toEqual([
      `/console/p/${ID}/factory Factory`,
      `/console/p/${ID}/factory/board Board`,
    ]);
  });

  test('a broken project file shows its path and error, not an empty state', () => {
    const html = render(`/console/p/${ID}/factory`, {
      views: [],
      errors: [
        { pack: 'acme.kit', source: 'project-file', path: '/repo/x.json', error: 'is invalid' },
      ],
    });
    expect(html).toContain('/repo/x.json');
    expect(html).toContain('is invalid');
    expect(html).not.toContain('No factory view applies');
  });

  test('a project no view applies to gets an empty state', () => {
    expect(render(`/console/p/${ID}/factory`, none)).toContain(
      'No factory view applies to this project'
    );
  });
});

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
const cards = (html: string): number => html.split('data-ask=').length - 1;

describe('Needs you', () => {
  test('is the project tab, its count on it; the Factory frame is not around it', () => {
    const html = render(`/console/p/${ID}/needs-you`, withView, sixAsks);
    expect(currentLinks(html)).toEqual([`/console/p/${ID}/needs-you Needs you6`]);
    expect(html).toContain('aria-label="6 waiting"');
    expect(html).toContain('6 things need you');
    expect(html).not.toContain('Issues come in; changes go out.');
  });

  test('lists every ask, where the Overview shows the newest three and says how many more', () => {
    const page = render(`/console/p/${ID}/needs-you`, withView, sixAsks);
    expect(cards(page)).toBe(6);
    for (let i = 0; i < 6; i++) expect(page).toContain(`Question ${i.toString()}?`);

    const overview = render(`/console/p/${ID}/factory`, withView, sixAsks);
    expect(cards(overview)).toBe(3);
    for (const i of [5, 4, 3]) expect(overview).toContain(`Question ${i.toString()}?`);
    expect(overview).toContain('3 more on Needs you');
  });
});

describe('the board', () => {
  test('sits under Board in the sub-navigation, its columns the declared stages', () => {
    const html = render(`/console/p/${ID}/factory/board`, withView);
    expect(currentLinks(html)).toEqual([
      `/console/p/${ID}/factory Factory`,
      `/console/p/${ID}/factory/board Board`,
    ]);
    expect(html).toContain('aria-label="Build"');
    expect(html).not.toContain('is coming next');
  });
});

describe('a stage, as its modal shows it', () => {
  test("shows the stage's label and blurb, then its workflow's steps framed by loop and include", () => {
    const html = renderStage('checks');
    expect(html).toContain('Checks');
    expect(html).toContain('Checks the change.');
    expect(html).toContain('up to 3 rounds');
    expect(html).toContain('>included<');
    // The stage's own step is marked as its own: a ring in its group's colour.
    const steps = [...html.matchAll(/<button[^>]*data-worker="[^"]*"[^>]*>/g)].map(([tag]) => tag);
    const own = steps.filter(tag => tag.includes('data-worker="this"'));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('title="review (engine id: rounds.review__review)"');
    expect(own[0]).toContain('outline:2px solid var(--node-approval)');
    // No step is dimmed: no opacity class, no opacity style, on any step or frame label.
    for (const tag of steps) {
      expect(tag).not.toMatch(/opacity-\d/);
      expect(tag).not.toMatch(/opacity:\s*0/);
    }
    expect(html).not.toMatch(/opacity-(35|50)/);
    // Its tag says so; another stage's step names that stage and opens it on its workflow.
    expect([...html.matchAll(/data-step-tag="this"[^>]*>([^<]*)</g)].map(([, t]) => t)).toEqual([
      'This stage',
    ]);
    const buildTags = [
      ...html.matchAll(/<a [^>]*data-step-tag="build"[^>]*href="([^"]*)"[^>]*>([^<]*)</g),
    ].map(([, href, text]) => `${text ?? ''} → ${href ?? ''}`);
    expect(buildTags).toEqual([
      `Build → /console/p/${ID}/factory?stage=build`,
      `Build → /console/p/${ID}/factory?stage=build`,
    ]);
    // A step no stage lists carries no tag and no ring.
    expect(steps.some(tag => tag.includes('data-worker="none"'))).toBe(true);
    expect(html).toContain('the stage that works it and opens that stage');
    expect(html).not.toContain('dimmed');
    for (const step of ['fix', 'base', 'review', 'tests', 'product', 'verdict'])
      expect(html).toContain(`>${step}</span>`);
  });

  test('a stage no workflow runs in says how an item arrives', () => {
    expect(renderStage('landed')).toContain('No workflow runs in this stage.');
  });
});

describe('the step page', () => {
  test('shows the kind, model, condition, prompt and YAML, and leads back to its stage', () => {
    const html = render(`/console/p/${ID}/factory/steps/deliver/rounds.fix`, withView);
    expect(html).toContain('<span data-id-tag=""');
    expect(html).toContain('Agent');
    expect(html).toContain('Builder tier, else large');
    // The condition in words, the expression as written on hover.
    expect(html).toContain(
      'title="$LOOP_PREV.verdict__verdict.output.outcome == &#x27;return&#x27;"'
    );
    expect(html).toContain('From command fix');
    expect(html).toContain('Fix what the checks returned');
    // The highlighted YAML block itself, not only its heading.
    expect(html).toContain('language-yaml');
    expect(html.replace(/<[^>]*>/g, '')).toContain('id: fix');
    // The stage's home is its modal over the Overview.
    expect(html).toContain(`href="/console/p/${ID}/factory?stage=build"`);
  });

  test('a step opened from a stage leads back to that stage', () => {
    const html = render(
      {
        pathname: `/console/p/${ID}/factory/steps/deliver/rounds.fix`,
        state: { fromStage: 'checks' },
      },
      withView
    );
    expect(html).toContain(`href="/console/p/${ID}/factory?stage=checks"`);
    expect(html).toContain('Back to Checks');
  });

  test('an included step leads back to the stage that works it', () => {
    const html = render(`/console/p/${ID}/factory/steps/deliver/rounds.review__review`, withView);
    expect(html).toContain('included from');
    expect(html).toContain(`href="/console/p/${ID}/factory?stage=checks"`);
  });

  test('a step the workflow does not have says so, and leads to its stage', () => {
    const html = render(`/console/p/${ID}/factory/steps/deliver/nope`, withView);
    expect(html).toContain(
      'There is no step <span class="font-mono">nope</span> in <span class="font-mono">deliver</span>.'
    );
    expect(html.replace(/<[^>]*>/g, '')).toContain('Open Build');
    expect(html).toContain(`href="/console/p/${ID}/factory?stage=build"`);
  });
});

describe('Factory routes', () => {
  test('an unknown path stays in the section, says so, and links its two pages', () => {
    const html = render(`/console/p/${ID}/factory/how-it-work`, withView);
    expect(html).toContain('No page here');
    // The frame is intact: the view's title and the project's tabs still draw.
    expect(html).toContain('Kit factory');
    const start = html.indexOf('aria-label="Factory pages"');
    expect(start).toBeGreaterThan(-1);
    const links = html.slice(start, html.indexOf('</nav>', start));
    expect([...links.matchAll(/href="([^"]*)"/g)].map(([, href]) => href)).toEqual([
      `/console/p/${ID}/factory`,
      `/console/p/${ID}/factory/board`,
    ]);
  });

  test('an unknown item keeps its own page and message', () => {
    expect(render(`/console/p/${ID}/factory/items/nope`, withView)).not.toContain('No page here');
  });
});
