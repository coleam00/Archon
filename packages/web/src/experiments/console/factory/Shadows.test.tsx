import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { BoardCard } from './BoardCard';
import { itemDetail, PROJECT, shippedView } from './item-detail.test-fixtures';
import { itemStory } from './lib/item-story';
import { StageStoryPanel } from './StoryPanel';
import { cardFields } from './lib/board';
import { VIEW, realItem } from './lib/board.test-fixtures';
import { EMPTY_STAGE_LIVE } from './lib/map-live';
import { layoutMap } from './lib/map-layout';
import type { ShadowDecision } from './lib/shadows';
import { buildTimeline } from './lib/timeline';
import { MapCard } from './map/MapCard';
import { MapDetails } from './map/MapDetails';
import { MapLegend } from './map/MapLegend';
import { DrilldownCard } from './stage/DrilldownCard';
import { stageModalLink } from './lib/views';
import type { BoardAsks } from './useBoardAsks';

// A shadow row's disclosure is a click, which static markup cannot reach.
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

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter>{element}</MemoryRouter>);
  });
  return container as unknown as HTMLElement;
}

/**
 * Rule 10: nothing a shadow did wears the running, success, warning or error colour, as a
 * token or as the utility that draws it.
 */
const STATE_COLOUR =
  /--(running|success|warning|error)\b|\b(text|bg|border)-(success|warning|error)\b/;

const at = '2026-11-18T12:00:00.000Z';
const failedChecks: ShadowDecision = {
  workflow: 'deliver',
  node: 'rounds.checks',
  round: 1,
  runId: 'r',
  decidedAt: at,
  read: {
    reads: 'checks',
    results: [
      { name: 'type-check', passed: false, seconds: 167, tail: 'exited with code 1' },
      { name: 'format', passed: true, seconds: 2, tail: null },
    ],
  },
};
const askedAdmit: ShadowDecision = {
  workflow: 'triage',
  node: 'admit',
  round: null,
  runId: 'a',
  decidedAt: at,
  read: { reads: 'verdict', value: 'ask', why: 'Nothing shows the operator looked at it.' },
};

describe("the item's story", () => {
  /** Item 111's story with an admit decision on its triage run and a checks one in round 1. */
  function story() {
    const detail = itemDetail('111');
    const triage = detail.runs.find(run => run.workflow === 'triage');
    const deliver = detail.runs.find(run => run.workflow === 'deliver');
    if (triage === undefined || deliver === undefined) throw new Error('item 111 delivered');
    triage.shadows = [{ ...askedAdmit, runId: triage.runId }];
    deliver.shadows = [{ ...failedChecks, runId: deliver.runId }];
    const rows = buildTimeline(shippedView, detail);
    return itemStory(shippedView, PROJECT, detail, rows, Date.parse(at));
  }
  const stagePanel = (id: string) => {
    const panel = story().find(entry => entry.kind === 'stage' && entry.stage.id === id);
    if (panel?.kind !== 'stage') throw new Error(`no ${id} panel`);
    return panel;
  };

  test('a decision sits in the panel of its stage: the badge, the label, what it would do', async () => {
    const page = await render(
      <StageStoryPanel view={shippedView} panel={stagePanel('triage')} asks={null} />
    );
    const row = page.querySelector('[data-shadow]');
    expect(row?.textContent).toContain('shadow');
    expect(row?.textContent).toContain('Would it start on its own');
    expect(row?.textContent).toContain('would ask you first');
    // Quieter than the real steps: the tertiary text, never a state colour.
    expect(row?.querySelector('p')?.className).toContain('text-text-tertiary');
    expect(row?.outerHTML).not.toMatch(STATE_COLOUR);
    const why = row?.querySelector('button');
    await act(async () => {
      why?.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event);
    });
    expect(row?.textContent).toContain('Nothing shows the operator looked at it.');
  });

  test("the project checks are the rounds grid's shadow row, in the round they decided in", async () => {
    const page = await render(
      <StageStoryPanel view={shippedView} panel={stagePanel('checks')} asks={null} />
    );
    const row = page.querySelector('[data-grid-row="Project checks"]');
    expect(row?.textContent).toContain('shadow');
    const cells = [...(row?.querySelectorAll('td') ?? [])].map(cell => cell.textContent);
    expect(cells[0]).toContain('2 checks · 1 failed: type-check · 2 min');
    expect(cells[1]).toContain('Not run');
    expect(row?.outerHTML).not.toMatch(STATE_COLOUR);
    // Shown in the grid, so not again as a line under the panel.
    expect(page.querySelector('[data-shadow]')).toBeNull();
    // Nor on the Build panel the same deliver run opened: it sits with its own stage.
    const build = await render(
      <StageStoryPanel view={shippedView} panel={stagePanel('build')} asks={null} />
    );
    expect(build.querySelector('[data-shadow]')).toBeNull();
    expect(build.textContent).not.toContain('Project checks');
  });
});

describe('a stage drill-down card standing for a shadow step', () => {
  // The card the Checks stage drew for deliver's project checks until the pack retired deliver:
  // the shipped view still declares that step a shadow, for the old runs it reads.
  const card = {
    title: 'Project checks',
    text: "Runs the project's declared checks and records the result; nothing acts on it",
    icon: 'shield-check' as const,
    kind: 'script' as const,
    covers: [{ workflow: 'deliver', steps: ['rounds.checks'] }],
  };

  test('carries the badge, the shadow accent and what it decided lately', async () => {
    const page = await render(
      <DrilldownCard
        view={shippedView}
        projectId={PROJECT}
        stageId="checks"
        card={card}
        onCard={[]}
        shadow={{ lately: ['last 5: all passed ×4 · 1 failed ×1'] }}
      />
    );
    const article = page.querySelector('article');
    expect(article?.querySelector('[data-shadow-badge]')).not.toBeNull();
    expect(article?.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain(
      'var(--node-opaque)'
    );
    expect(article?.textContent).toContain('last 5: all passed ×4 · 1 failed ×1');
    expect(article?.outerHTML).not.toMatch(STATE_COLOUR);
  });

  test('a card standing for no shadow step has neither', async () => {
    const page = await render(
      <DrilldownCard
        view={shippedView}
        projectId={PROJECT}
        stageId="checks"
        card={{ ...card, title: 'Code review' }}
        onCard={[]}
        shadow={null}
      />
    );
    expect(page.querySelector('[data-shadow-badge]')).toBeNull();
    expect(page.innerHTML).not.toContain('--node-opaque');
  });
});

describe('a board card in Triage', () => {
  test('one line: what the admit gate would do, in the shadow style', async () => {
    // Any real item: the line reads only its progress and the stage it is placed in.
    const item = realItem('1');
    if (item.progress === null) throw new Error('fixture item 1 has progress');
    item.progress.running = null;
    item.progress.shadows = [askedAdmit];
    const triage = VIEW.stages.find(stage => stage.id === 'triage');
    if (triage === undefined) throw new Error('the shipped view has a triage stage');
    const fields = cardFields(VIEW, PROJECT, item, { stage: triage });
    const asks: BoardAsks = {
      asksOf: () => [],
      faceOf: () => null,
      answeredLine: () => null,
      open: null,
      openFor: () => undefined,
      close: () => undefined,
      settle: () => undefined,
    };
    const page = await render(
      <BoardCard
        projectId={PROJECT}
        card={fields}
        moved={false}
        accent="var(--node-script)"
        asks={asks}
      />
    );
    const line = page.querySelector('[data-shadow-line]');
    expect(line?.textContent).toBe('shadowwould ask you first');
    expect(line?.getAttribute('title')).toBe('Nothing shows the operator looked at it.');
    // Rule 10: a shadow line reads at the 13 px meta size; the badge keeps its own 12.
    expect(line?.className).toContain('text-console-13');
    expect(line?.outerHTML).not.toMatch(STATE_COLOUR);
  });
});

describe('the map', () => {
  const layout = layoutMap(shippedView);

  test('a stage holding a shadow step carries the badge by its name, saying it on hover', async () => {
    const lines = (stage: { id: string }): string[] =>
      stage.id === 'checks' ? ['Project checks · last 5: all passed ×5'] : [];
    const marked: string[] = [];
    const titles: (string | null)[] = [];
    for (const card of layout.cards) {
      const stages = card.stages.flatMap(id => shippedView.stages.filter(stage => stage.id === id));
      const page = await render(
        <MapCard
          card={card}
          stages={stages}
          live={() => EMPTY_STAGE_LIVE}
          selected={false}
          stageLink={stage => stageModalLink('cb-1', stage)}
          onDetails={() => undefined}
          shadows={lines}
        />
      );
      for (const badge of page.querySelectorAll('[data-shadow-badge]')) {
        marked.push(badge.closest('[data-stage]')?.getAttribute('data-stage') ?? card.id);
        titles.push(badge.getAttribute('title'));
      }
    }
    expect(marked).toEqual(['checks']);
    expect(titles).toEqual([
      'shadow: decides what it would do and does nothing\nProject checks · last 5: all passed ×5',
    ]);
    // The map's lines are the declared arrows only: declaring shadows changes none of them.
    expect(layout).toEqual(layoutMap({ ...shippedView, shadows: undefined }));
  });
});

describe("the map's details and legend", () => {
  test("a stage's details list its shadow steps; the legend says what the badge means", async () => {
    const checks = shippedView.stages.find(stage => stage.id === 'checks');
    if (checks === undefined) throw new Error('the shipped view has a checks stage');
    const details = await render(
      <MapDetails
        projectId={PROJECT}
        view={shippedView}
        title="Checks & review"
        stages={[
          {
            stage: checks,
            live: EMPTY_STAGE_LIVE,
            notes: [],
            shadows: ['Project checks · last 5: all passed ×5'],
          },
        ]}
        onClose={() => undefined}
      />
    );
    expect(details.textContent).toContain('Shadow steps');
    expect(details.textContent).toContain('Each decides what it would do and does nothing.');
    expect(details.textContent).toContain('Project checks · last 5: all passed ×5');
    expect(details.innerHTML).not.toMatch(STATE_COLOUR);
    const legend = await render(<MapLegend tones={['check']} shadow />);
    expect(legend.querySelector('[data-shadow-badge]')?.parentElement?.textContent).toBe(
      'shadowA step that decides what it would do and does nothing; hover it for which and what it decided'
    );
    const plain = await render(<MapLegend tones={['check']} shadow={false} />);
    expect(plain.querySelector('[data-shadow-badge]')).toBeNull();
  });
});
