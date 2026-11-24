/**
 * `/console/p/:projectId/factory/settings`: how this project has set up the pack its factory
 * view draws (the owner change of 2026-11-23 moved the page here from the sidebar Factory).
 */
import { afterEach, expect, test } from 'bun:test';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryPackSettings, FactoryViews } from '../../skills/factory';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { projectRoutes } from '../../routes/project-routes';
import { installDom } from '../../test-dom.test-helpers';
import { documentPageProblems } from '../document.test-helpers';

const { mount } = await installDom();
// A read the cache does not answer never answers.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => undefined), {
  preconnect: globalThis.fetch.preconnect,
});

const ID = 'cb-1';
let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  invalidate('factory-views');
  invalidate(K.factoryPackSettings('acme.kit'));
});

const views: FactoryViews = {
  views: [
    {
      pack: 'acme/kit',
      packKey: 'acme.kit',
      runNames: {},
      source: 'project-file',
      path: '/repo/.archon/packs/acme.kit.factory-view.json',
      declaration: {
        version: 1,
        pack: 'acme/kit',
        title: 'Kit factory',
        summary: 'Issues come in; changes go out.',
        stages: [{ id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] }],
        placement: {},
        endings: {},
        landed: { stage: 'landed' },
        map: { cards: [], arrows: [] },
      },
    },
  ],
  errors: [],
};

const setting = (
  name: string,
  more: Partial<FactoryPackSettings['settings'][number]> = {}
): FactoryPackSettings['settings'][number] => ({
  name,
  description: null,
  default: '',
  type: 'string',
  shadow: false,
  pointsTo: null,
  section: null,
  whenLive: null,
  ...more,
});
const web: FactoryPackSettings['projects'][number] = {
  codebaseId: 'cb-1',
  name: 'web',
  error: null,
  values: {
    triage_policy: { state: 'empty' },
    checks_file: {
      state: 'set',
      value: 'checks.yaml',
      problem: null,
      file: {
        display: 'checks.yaml',
        full: '/repo/checks.yaml',
        status: 'found',
        error: null,
        checks: [{ name: 'lint', run: 'bun run lint' }],
      },
    },
    validate_command: { state: 'set', value: 'bun test', problem: null, file: null },
  },
  undeclared: [{ name: 'size', value: 'large' }],
};
const SETTINGS: FactoryPackSettings = {
  pack: 'acme.kit',
  declaration: { path: '/home/plugins/acme/kit/.pack/pack.yaml', error: null },
  settingsFile: '.archon/packs/acme.kit.yaml',
  sections: [
    {
      id: 'proven',
      eyebrow: 'Checks',
      title: 'How a change is proven',
      kind: 'check',
      icon: 'flask',
    },
    {
      id: 'held',
      eyebrow: 'Policies',
      title: 'What work is held to',
      kind: 'stage',
      icon: 'scale',
    },
  ],
  settings: [
    setting('triage_policy', { pointsTo: 'policy', section: 'held' }),
    setting('checks_file', {
      shadow: true,
      pointsTo: 'checks',
      section: 'proven',
      whenLive: 'Would run checks you have not reviewed',
    }),
    setting('validate_command', { default: null }),
  ],
  mapErrors: [],
  projects: [web],
};

/** The Settings page of this project, its pack's settings read as `settings`. */
async function settingsPage(settings: FactoryPackSettings = SETTINGS): Promise<HTMLElement> {
  set(K.factoryViews(ID), views);
  set(K.projectAttention(ID), { items: [], runs: [], degraded: [] });
  set(K.factoryPackSettings('acme.kit'), settings);
  const page = await mount(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory/settings`]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
  unmount = page.unmount;
  return page.container;
}
const card = (page: HTMLElement, name: string): Element | null =>
  page.querySelector(`[data-setting="${name}"]`);
const value = (page: HTMLElement, name: string): string | null | undefined =>
  card(page, name)?.querySelector('[data-setting-value]')?.textContent;
const rows = (within: Element | null | undefined): string[] =>
  [...(within?.querySelectorAll('dl > div') ?? [])].map(row =>
    [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent].join(': ')
  );
const chips = (page: HTMLElement): string[] =>
  [...page.querySelectorAll('[data-stat-chip]')].map(chip => chip.textContent ?? '');
const bandTitle = (page: HTMLElement): string | null | undefined =>
  page.querySelector('[aria-label="Summary"] h2')?.textContent;

test("the Factory tab's Settings page: its band, sections in the map's order and each setting's value", async () => {
  const page = await settingsPage();
  const nav = page.querySelector('nav[aria-label="Factory"]');
  expect([...(nav?.querySelectorAll('a') ?? [])].map(a => a.textContent)).toEqual([
    'Overview',
    'Board',
    'Settings',
  ]);
  expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe('Settings');
  expect(bandTitle(page)).toBe('How web has set up its factory');
  // web sets checks and validate; triage is empty, so it falls back to the pack.
  expect(chips(page)).toEqual([
    '3settings',
    '2set by this project',
    '1pack default',
    '1shadow today',
  ]);

  const sections = [...page.querySelectorAll('[data-doc-section]')];
  expect(sections.map(section => section.querySelector('h2')?.textContent)).toEqual([
    'How a change is proven',
    'What work is held to',
    'Other settings',
    'Not declared by the pack',
  ]);
  expect(
    sections
      .slice(0, 3)
      .map(section => [...section.querySelectorAll('[data-setting] h3')].map(h => h.textContent))
  ).toEqual([['Checks file'], ['Triage policy'], ['Validate command']]);
  expect(rows(sections[3])).toEqual(['size: large']);

  expect(card(page, 'triage_policy')?.querySelector('[data-pack-default]')).not.toBeNull();
  expect(value(page, 'validate_command')).toBe('bun test');
  expect(rows(card(page, 'checks_file')?.querySelector('[aria-label="Checks"]'))).toEqual([
    'lint: bun run lint',
  ]);
  // The shadow badge marks the shadow setting only, with what would change.
  const badged = [...page.querySelectorAll('[data-setting]')]
    .filter(li => li.querySelector('[data-shadow-badge]') !== null)
    .map(li => li.getAttribute('data-setting'));
  expect(badged).toEqual(['checks_file']);
  expect(card(page, 'checks_file')?.textContent).toContain(
    'Would run checks you have not reviewed'
  );
  expect(documentPageProblems(page)).toEqual([]);
});

test("a project the settings read did not list says so and shows the pack's defaults", async () => {
  const page = await settingsPage({ ...SETTINGS, projects: [] });
  expect(page.querySelector('[role="alert"]')?.textContent).toBe(
    "This project's settings were not read; the page shows the pack's defaults."
  );
  expect(bandTitle(page)).toBe('How Kit is set up');
  expect(value(page, 'validate_command')).toBe('Pack default');
});
