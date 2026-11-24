/**
 * No raw engine step id where a person reads (DESIGN.md, "Step names, everywhere a person
 * reads"): each page's words and accessible names are scanned for an id's shape over fixtures
 * full of loop bodies, includes and failed steps. `title` and `href` may hold the raw id.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes } from 'react-router';
import type {
  FactoryItem,
  FactoryItemDetail,
  FactoryViews,
  FactoryWorkflow,
} from '../skills/factory';
import type { AttentionQueue } from '../skills/runs';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import { itemDetail, shippedListed } from './item-detail.test-fixtures';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import { FIXTURE_NOW, delivering, endLastRun, realItem, VIEW } from './lib/board.test-fixtures';
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
const DELIVER = deliverJson as FactoryWorkflow;
const listing: FactoryViews = {
  views: [{ ...shippedListed, declaration: VIEW }],
  errors: [],
};
const quiet: AttentionQueue = { items: [], runs: [], degraded: [] };

afterEach(() => {
  for (const kind of ['factory-views', 'factory-workflow', 'factory-items', 'project', 'runs'])
    invalidate(kind);
});

/** Item 8 delivering `step`, under its own key so several can sit on one board. */
function on(step: string, key: string): FactoryItem {
  const item = delivering(step);
  return { ...item, item: { ...item.item, id: `id-${key}`, key } };
}

const ITEMS: FactoryItem[] = [
  on('rounds.review__review', '8'),
  on('hostrounds.host__host', '81'),
  on('rounds.mystery__mystery', '82'),
  on('build__build', '83'),
  endLastRun(realItem('3'), 'failed', null, 'rounds.tests__tests'),
];

/**
 * The view as it was before the pack retired `deliver`, which these fixtures' items run, with no
 * drill-downs, so a stage draws deliver's step graph (a drill-down puts it behind a tab).
 */
const graphsListing: FactoryViews = {
  ...listing,
  views: listing.views.map(listed => ({
    ...listed,
    declaration: {
      ...listed.declaration,
      retired: undefined,
      stages: listed.declaration.stages.map(({ drilldown: _drilldown, ...stage }) => stage),
    },
  })),
};

function seed(views: FactoryViews, detail?: FactoryItemDetail): void {
  set(K.factoryViews(ID), views);
  set(K.projectAttention(ID), quiet);
  set(K.factoryWorkflow(ID, 'deliver'), DELIVER);
  set(K.factoryItems(ID), { items: ITEMS, members: {} });
  if (detail !== undefined) set(K.factoryItem(ID, detail.item.item.key), detail);
}

function render(path: string, detail?: FactoryItemDetail, views = listing): string {
  seed(views, detail);
  return markup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
}

/** A stage on the tab it opens on, as its modal draws it; the modal portals, which static markup cannot reach. */
function renderStage(stageId: string, views = listing): string {
  seed(views);
  const view = views.views[0]!.declaration;
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
  return markup(
    <MemoryRouter>
      <Stage />
    </MemoryRouter>
  );
}

const markup = (element: ReactElement): string => renderToStaticMarkup(element);

/** What a person reads: the text between tags, and every accessible name. */
function readable(html: string): string {
  const names = [...html.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1] ?? '');
  const words = html.replace(/<[^>]*>/g, ' ');
  return [words, ...names]
    .join(' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

/** The loops of the pack's deliver workflow, from its own read, not from a list here. */
const LOOPS = DELIVER.groups.filter(group => group.kind === 'loop').map(group => group.id);
const ID_SHAPES = [/[A-Za-z0-9]__[A-Za-z0-9]/, new RegExp(`\\b(${LOOPS.join('|')})\\.[a-z]`)];

function rawIds(html: string): string[] {
  const text = readable(html);
  return ID_SHAPES.flatMap(shape => {
    const global = new RegExp(shape.source, 'g');
    return [...text.matchAll(global)].map(match =>
      text.slice(Math.max(0, match.index - 30), match.index + 30)
    );
  });
}

/** Every `title` on the page: where the engine id belongs, on hover. */
const titles = (html: string): string[] =>
  [...html.matchAll(/ title="([^"]*)"/g)].map(match => match[1] ?? '');

describe('no raw step id where a person reads', () => {
  test('the Overview, the board and its Table view name steps, their engine ids on hover', () => {
    expect(rawIds(render(`/console/p/${ID}/factory`))).toEqual([]);
    const html = render(`/console/p/${ID}/factory/board`);
    expect(html).toContain('Checks · Code review · round 2');
    expect(html).toContain('failed at Test check');
    expect(titles(html)).toContain(
      'Checks · Code review · round 2 (engine id: rounds.review__review)'
    );
    expect(rawIds(html)).toEqual([]);
    expect(rawIds(render(`/console/p/${ID}/factory/board?view=table`))).toEqual([]);
  });

  test('the item page and its rounds grid, the step id on hover', () => {
    const html = render(`/console/p/${ID}/factory/items/111`, itemDetail('111'));
    expect(titles(html).some(title => title.startsWith('rounds.tests__tests'))).toBe(true);
    expect(rawIds(html)).toEqual([]);
  });

  test("the stage modal's step graph, and its conditions by the names the graph prints", () => {
    const html = renderStage('checks', graphsListing);
    expect(html).toContain('title="Code review (engine id: rounds.review__review)');
    expect(titles(html)).toContain('rounds');
    expect(rawIds(html)).toEqual([]);
    // A condition reads a step by its bare id ("if rounds = approve"), which neither id
    // shape catches, so every condition's subject is checked against the declared names.
    const subjects = [...readable(html).matchAll(/\bif (.+?) [=≠≤≥<>] /g)].map(match => match[1]);
    expect(subjects.sort()).toEqual([
      'Check rounds',
      'Check rounds',
      'Reads CI and PR reviews',
      'Verdict',
    ]);
  });

  test('the step page: the name with its id as a tag, and Runs when by step name', () => {
    const html = render(`/console/p/${ID}/factory/steps/deliver/rounds.review__review`);
    expect(
      /<h2[^>]*><span[^>]*>([^<]*)<span data-id-tag=""[^>]*>([^<]*)<\/span>/.exec(html)?.slice(1)
    ).toEqual(['Code review', 'rounds.review__review']);
    const fix = render(`/console/p/${ID}/factory/steps/deliver/rounds.fix`);
    expect(readable(fix)).toMatch(/Runs when\s+if Verdict = return/);
    expect(rawIds(/<dl[\s\S]*?<\/dl>/.exec(fix)?.[0] ?? '')).toEqual([]);
  });
});
