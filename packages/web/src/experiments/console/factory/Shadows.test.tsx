import { describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { BoardCard } from './BoardCard';
import { itemDetail, PROJECT, shippedView } from './item-detail.test-fixtures';
import { itemStory } from './lib/item-story';
import { StageStoryPanel } from './StoryPanel';
import { cardFields } from './lib/board';
import { VIEW, realItem } from './lib/board.test-fixtures';
import { EMPTY_STAGE_LIVE } from './lib/map-live';
import type { ShadowDecision } from './lib/shadows';
import { buildTimeline } from './lib/timeline';
import { MapDetails } from './map/MapDetails';
import { MapLegend } from './map/MapLegend';
import { DrilldownCard } from './stage/DrilldownCard';
import type { BoardAsks } from './useBoardAsks';
import { installDom } from '../test-dom.test-helpers';

// A shadow row's disclosure is a click, which static markup cannot reach.
const { dom, mount } = await installDom();
const render = async (element: ReactElement): Promise<HTMLElement> =>
  (await mount(<MemoryRouter>{element}</MemoryRouter>)).container;

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
    // Shown in the grid, so not again as a line under the panel.
    expect(page.querySelector('[data-shadow]')).toBeNull();
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

  test('carries the badge and what it decided lately', async () => {
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
    expect(article?.textContent).toContain('last 5: all passed ×4 · 1 failed ×1');
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
    const legend = await render(<MapLegend tones={['check']} shadow />);
    expect(legend.querySelector('[data-shadow-badge]')?.parentElement?.textContent).toBe(
      'shadowA step that decides what it would do and does nothing; hover it for which and what it decided'
    );
  });
});
