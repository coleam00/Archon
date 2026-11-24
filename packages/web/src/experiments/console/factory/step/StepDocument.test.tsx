import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryItem, FactoryViews, FactoryWorkflow } from '../../skills/factory';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { projectRoutes } from '../../routes/project-routes';
import { documentPageProblems, outlineBoxes } from '../document.test-helpers';
import { capturedItemsPage } from '../lib/fixtures/factory-items-page';
import deliverJson from '../lib/fixtures/deliver-workflow.json';

const ID = 'cb-1';
const dom = new Window();

afterEach(() => {
  invalidate('factory-views');
  invalidate('factory-workflow');
  invalidate('factory-items');
  invalidate('project');
});
afterAll(async () => {
  await dom.happyDOM.close();
});

const deliver = deliverJson as FactoryWorkflow;
/**
 * `deliver` with a prompt that reads inputs and a step's output, one input in a code span, and
 * a model on its shell step, which the page must still not show.
 */
const WITH_PROMPT: FactoryWorkflow = {
  ...deliver,
  steps: deliver.steps.map(step =>
    step.key === 'rounds.base'
      ? { ...step, model: ['@lander'] }
      : step.key === 'rounds.fix'
        ? {
            ...step,
            prompt:
              '# Fix what the checks returned\n\nFix $INPUTS.item on `$INPUTS.land_on` from $build__build.output.',
            references: [
              { kind: 'input', token: '$INPUTS.item', name: 'item' },
              { kind: 'input', token: '$INPUTS.land_on', name: 'land_on' },
              { kind: 'output', token: '$build__build.output', key: 'build__build', path: null },
            ],
          }
        : step
  ),
};

const views: FactoryViews = {
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
            drilldown: {
              phases: [
                {
                  label: 'Fix',
                  cards: [
                    {
                      title: 'Fix',
                      text: 'Fixes what the checks sent back',
                      icon: 'wrench',
                      kind: 'agent',
                      covers: [{ workflow: 'deliver', steps: ['rounds.fix'] }],
                    },
                  ],
                },
              ],
            },
          },
          { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
        ],
        steps: { deliver: { 'rounds.fix': 'Fix the change' } },
        placement: {},
        endings: {},
        landed: { stage: 'landed' },
        map: { cards: [], arrows: [] },
      },
    },
  ],
  errors: [],
};

function page(stepKey: string, items: FactoryItem[] = []): HTMLElement {
  set(K.factoryViews(ID), views);
  set(K.factoryWorkflow(ID, 'deliver'), WITH_PROMPT);
  set(K.factoryItems(ID), { items, members: {} });
  const root = dom.document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory/steps/deliver/${stepKey}`]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
  return root as unknown as HTMLElement;
}

const chips = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[aria-label="Key facts"] [data-stat-chip]')].map(
    chip => `${chip.getAttribute('data-stat-chip') ?? ''}: ${chip.textContent ?? ''}`
  );

describe('the step page as a document page', () => {
  test('holds to owner change 5: panels and headed sections only, no outline boxes', () => {
    for (const key of ['rounds.fix', 'rounds.base', 'build__build']) {
      const root = page(key, key === 'build__build' ? capturedItemsPage.items : []);
      expect({ key, problems: documentPageProblems(root) }).toEqual({ key, problems: [] });
      expect({ key, outlines: outlineBoxes(root) }).toEqual({ key, outlines: [] });
    }
  });

  test('opens with what it does and its key facts', () => {
    const root = page('rounds.fix');
    const band = root.querySelector('[aria-label="Summary"]');
    expect(band?.querySelector('p')?.textContent).toBe('Fixes what the checks sent back');
    expect(chips(root)).toEqual([
      'tone: Agentstep',
      'neutral: Builder tier, else largemodel',
      'neutral: deliverworkflow',
      'neutral: Buildstage',
      'neutral: 0on this step now',
    ]);
    // The stage chip opens that stage's modal on the Overview.
    expect(band?.querySelector('a')?.getAttribute('href')).toBe(
      `/console/p/${ID}/factory?stage=build`
    );
  });

  test('the prompt reads as a document, its references as chips; the facts list its inputs', () => {
    const root = page('rounds.fix');
    expect(
      [...root.querySelectorAll('[data-ref-label]')].map(chip =>
        chip.getAttribute('data-ref-label')
      )
    ).toEqual(['item', 'land on', 'Build output']);
    // "What it does" is the covering drill-down card's line.
    const does = root.querySelector('[data-doc-columns] section');
    expect(does?.textContent).toBe('What it doesFixFixes what the checks sent back');
    const aside = root.querySelector('aside');
    const facts = aside?.querySelector('dl')?.textContent ?? '';
    expect(facts).toContain('Inputs it readsitemland on');
    expect(facts).toContain('Reads from stepsBuild output');
  });

  test('its workflow marks this step and links every other to its own page', () => {
    const list = page('rounds.fix').querySelector('aside ol');
    const current = list?.querySelectorAll('[data-this-step]');
    expect(current?.length).toBe(1);
    expect(current?.[0]?.textContent).toContain('Fix the change');
    expect(current?.[0]?.closest('a')).toBeNull();
    const links = [...(list?.querySelectorAll('a') ?? [])].map(link => link.getAttribute('href'));
    expect(links).toHaveLength(deliver.steps.length - 1);
    expect(links).toContain(`/console/p/${ID}/factory/steps/deliver/rounds.base`);
  });

  test('a script step shows its script on a numbered code panel, and no prompt', () => {
    const root = page('rounds.base');
    // A step the view file names nothing reads as its id in sentence case.
    expect(root.querySelector('[aria-label="Summary"] h2')?.textContent).toBe('Baserounds.base');
    const code = root.querySelector('ol[aria-label^="The script of"]');
    expect([...(code?.querySelectorAll('li') ?? [])].map(line => line.textContent)).toEqual([
      '1git fetch origin main',
      '2git diff --stat origin/main',
    ]);
    expect(root.querySelector('.chat-markdown')).toBeNull();
    // A shell step with a model declared still shows no model: it runs no agent.
    expect(chips(root).some(chip => chip.includes('model'))).toBe(false);
    expect(root.querySelector('aside dl')?.textContent).not.toContain('Runs on');
  });

  test('the count chip is in the running colour; the empty state links the board', () => {
    expect(chips(page('build__build', capturedItemsPage.items))).toContain(
      'running: 3on this step now'
    );
    // Inside the items section: the frame's own navigation links the board too.
    const items = [...page('rounds.fix').querySelectorAll('[data-doc-section]')].find(
      section => section.querySelector('h2')?.textContent === 'Items on this step now'
    );
    expect(
      [...(items?.querySelectorAll('a') ?? [])].map(link => link.getAttribute('href'))
    ).toEqual([`/console/p/${ID}/factory/board`]);
  });
});
