/**
 * `/console/p/:projectId/factory/settings`: how this project has set up the pack its factory
 * view draws (the owner change of 2026-11-23 moved the page here from the sidebar Factory).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryPackSettings, FactoryViews } from '../../skills/factory';
import type { AttentionQueue } from '../../skills/runs';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { projectRoutes } from '../../routes/project-routes';
import { documentPageProblems, outlineBoxes } from '../document.test-helpers';

// A failed read lands after the first render, which static markup cannot reach.
const dom = new Window({ url: 'http://localhost' });
/** The project's attention stream, which says nothing here. */
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;
/** A read the cache does not answer never answers, unless a test says otherwise. */
const silent = Object.assign((): Promise<Response> => new Promise<Response>(() => undefined), {
  preconnect: originalFetch.preconnect,
});
globalThis.fetch = silent;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const ID = 'cb-1';
let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  invalidate('factory-views');
  invalidate(K.factoryPackSettings('acme.kit'));
});

const quiet: AttentionQueue = { items: [], runs: [], degraded: [] };
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

/** Project `id`'s page at `at`, its view and attention read. */
async function mount(at: string, id: string = ID): Promise<HTMLElement> {
  set(K.factoryViews(id), views);
  set(K.projectAttention(id), quiet);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <Routes>{projectRoutes('/console/')}</Routes>
      </MemoryRouter>
    )
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

type ProjectSettings = FactoryPackSettings['projects'][number];
const file = (
  display: string,
  status: 'found' | 'missing',
  checks: { name: string; run: string }[] | null = null
) => ({ display, full: `/repo/${display}`, status, error: null, checks });
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
const web: ProjectSettings = {
  codebaseId: 'cb-1',
  name: 'web',
  error: null,
  values: {
    triage_policy: { state: 'empty' },
    land_policy: {
      state: 'set',
      value: 'docs/land.md',
      problem: null,
      file: file('docs/land.md', 'missing'),
    },
    checks_file: {
      state: 'set',
      value: 'checks.yaml',
      problem: null,
      file: file('checks.yaml', 'found', [{ name: 'lint', run: 'bun run lint' }]),
    },
    validate_command: { state: 'set', value: 'bun test', problem: null, file: null },
  },
  undeclared: [{ name: 'size', value: 'large' }],
};
const api: ProjectSettings = {
  codebaseId: 'cb-2',
  name: 'api',
  error: null,
  values: {
    triage_policy: { state: 'unset' },
    land_policy: { state: 'unset' },
    checks_file: { state: 'unset' },
    validate_command: { state: 'unset' },
  },
  undeclared: [{ name: 'colour', value: 'red' }],
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
    {
      id: 'filed',
      eyebrow: 'Discoveries',
      title: 'What gets filed',
      kind: 'outcome',
      icon: 'flag',
    },
  ],
  settings: [
    setting('triage_policy', {
      description: 'Path to the triage policy.',
      pointsTo: 'policy',
      section: 'held',
    }),
    setting('land_policy', {
      shadow: true,
      pointsTo: 'policy',
      section: 'held',
      whenLive: 'Would land a change without asking you',
    }),
    setting('checks_file', { shadow: true, pointsTo: 'checks', section: 'proven' }),
    setting('validate_command', { default: null }),
  ],
  mapErrors: [],
  projects: [web, api],
};

/** The Settings page of project `id`, its pack's settings read as `settings`. */
async function settingsPage(
  settings: FactoryPackSettings = SETTINGS,
  id: string = ID
): Promise<HTMLElement> {
  set(K.factoryPackSettings('acme.kit'), settings);
  return mount(`/console/p/${id}/factory/settings`, id);
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
const sections = (page: HTMLElement): string[] =>
  [...page.querySelectorAll('[data-doc-section]')].map(
    section => section.querySelector('h2')?.textContent ?? ''
  );
const bandTitle = (page: HTMLElement): string | null | undefined =>
  page.querySelector('[aria-label="Summary"] h2')?.textContent;
const hrefs = (within: ParentNode | null | undefined): string[] =>
  [...(within?.querySelectorAll('a') ?? [])].map(a => a.getAttribute('href') ?? '');

describe('/console/p/:projectId/factory/settings', () => {
  test("is the Factory tab's third page, opening with a band counting how this project set it up", async () => {
    const page = await settingsPage();
    const nav = page.querySelector('nav[aria-label="Factory"]');
    expect([...(nav?.querySelectorAll('a') ?? [])].map(a => a.textContent)).toEqual([
      'Overview',
      'Board',
      'Settings',
    ]);
    expect(hrefs(nav)).toEqual([
      `/console/p/${ID}/factory`,
      `/console/p/${ID}/factory/board`,
      `/console/p/${ID}/factory/settings`,
    ]);
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe('Settings');
    expect(page.querySelector('[data-doc-page] > [aria-label="Summary"]')).not.toBeNull();
    expect(bandTitle(page)).toBe('How web has set up its factory');
    // Where it reads, said quietly in the band.
    expect(page.querySelector('[aria-label="Summary"]')?.textContent).toContain(
      "Read from the pack's declaration and this project's .archon/packs/acme.kit.yaml"
    );
    // web sets land, checks and validate; triage is empty, so it falls back to the pack.
    expect(chips(page)).toEqual([
      '4settings',
      '3set by this project',
      '1pack default',
      '2shadows today',
    ]);
    expect(page.querySelector('[data-stat-chip="shadow"]')?.textContent).toBe('2shadows today');
  });

  test('names no other project that runs the pack, and links to none', async () => {
    const page = await settingsPage();
    const body = page.querySelector('[data-doc-page]');
    expect(body?.textContent).not.toContain('api');
    expect(body?.textContent).not.toContain('colour');
    expect(body?.querySelector('nav[aria-label="Project"]')).toBeNull();
    expect(hrefs(body)).toEqual([]);
  });

  test('each project reads its own values', async () => {
    expect(value(await settingsPage(), 'validate_command')).toBe('bun test');
    await unmount?.();
    unmount = undefined;
    const other = await settingsPage(SETTINGS, 'cb-2');
    expect(bandTitle(other)).toBe('How api has set up its factory');
    expect(value(other, 'validate_command')).toBe('Pack default');
    expect(other.querySelector('[data-doc-page]')?.textContent).not.toContain('web');
  });

  test("a project the settings read did not list says so and shows the pack's defaults", async () => {
    const page = await settingsPage({ ...SETTINGS, projects: [api] });
    expect(page.querySelector('[role="alert"]')?.textContent).toBe(
      "This project's settings were not read; the page shows the pack's defaults."
    );
    expect(bandTitle(page)).toBe('How Kit is set up');
    expect(chips(page)).toEqual(['4settings', '2shadows today']);
    expect(value(page, 'validate_command')).toBe('Pack default');
    expect(page.querySelector('[data-doc-page]')?.textContent).not.toContain('api');
  });

  test('an empty or unset value is the "Pack default" pill; a set value is shown as it is', async () => {
    const page = await settingsPage();
    expect(card(page, 'triage_policy')?.querySelector('[data-pack-default]')).not.toBeNull();
    expect(value(page, 'validate_command')).toBe('bun test');
    // A command wraps at its spaces (overflow-wrap: anywhere), never mid-word (break-all).
    const command = card(page, 'validate_command')?.querySelector('[data-setting-value] span');
    expect(command?.className).toContain('[overflow-wrap:anywhere]');
    expect(command?.className).not.toContain('break-all');
  });

  test('a map key the pack does not declare, and an unreadable project file, say so', async () => {
    const page = await settingsPage({
      ...SETTINGS,
      mapErrors: ['The factory overview presents setting "gone", which the pack does not declare'],
      projects: [{ ...web, error: 'not valid YAML', values: {} }, api],
    });
    const alerts = [...page.querySelectorAll('[role="alert"]')].map(alert => alert.textContent);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain("web's settings file could not be read");
    expect(alerts[0]).toContain('not valid YAML');
    expect(alerts[1]).toContain('"gone"');
    expect(chips(page)).toEqual(['4settings', '2shadows today']);
  });

  test("sections follow the map's order; an unmapped setting is in Other, last", async () => {
    const page = await settingsPage();
    expect(sections(page)).toEqual([
      'How a change is proven',
      'What work is held to',
      'Other settings',
      'Not declared by the pack',
    ]);
    const names = (section: Element | undefined) =>
      [...(section?.querySelectorAll('[data-setting] h3') ?? [])].map(h => h.textContent);
    const [proven, held, other] = page.querySelectorAll('[data-doc-section]');
    expect(names(proven)).toEqual(['Checks file']);
    expect(names(held)).toEqual(['Triage policy', 'Land policy']);
    expect(names(other)).toEqual(['Validate command']);
  });

  test('a panel has its plain name, its id tag, its description, and a declared default as meta', async () => {
    const [triage, ...rest] = SETTINGS.settings;
    const page = await settingsPage({
      ...SETTINGS,
      settings: [{ ...(triage ?? setting('triage_policy')), default: 'policy/triage.md' }, ...rest],
    });
    const panel = card(page, 'triage_policy');
    expect(panel?.querySelector('h3')?.textContent).toBe('Triage policy');
    expect(panel?.querySelector('[data-id-tag]')?.textContent).toBe('triage_policy');
    expect(panel?.textContent).toContain('Path to the triage policy.');
    expect(panel?.textContent).toContain('Pack default: policy/triage.md');
  });

  test('an empty declared default adds no meta line under the "Pack default" pill', async () => {
    const page = await settingsPage();
    // The pill says the pack applies; "Pack default: none" under it would contradict it.
    expect(card(page, 'triage_policy')?.textContent).not.toContain('Pack default:');
    expect(card(page, 'validate_command')?.textContent).not.toContain('Pack default:');
  });

  test('a policy path not in the project says "file not found", its whole path on hover', async () => {
    const page = await settingsPage();
    expect(value(page, 'land_policy')).toBe('docs/land.mdfile not found');
    expect(card(page, 'land_policy')?.querySelector('[title="/repo/docs/land.md"]')).not.toBeNull();
  });

  test('a checks file is shown as rows of its checks, name and command, in an inset box', async () => {
    const page = await settingsPage();
    const checks = card(page, 'checks_file')?.querySelector('[aria-label="Checks"]');
    expect(checks?.getAttribute('data-doc-panel')).toBe('inset');
    expect(rows(checks)).toEqual(['lint: bun run lint']);
  });

  test('the shadow badge marks the shadow settings only, with what would change', async () => {
    const page = await settingsPage();
    const badged = [...page.querySelectorAll('[data-setting]')]
      .filter(li => li.querySelector('[data-shadow-badge]') !== null)
      .map(li => li.getAttribute('data-setting'));
    expect(badged).toEqual(['checks_file', 'land_policy']);
    expect(card(page, 'land_policy')?.textContent).toContain(
      'Would land a change without asking you'
    );
    // A shadow's bar is rule 10's --node-opaque; any other panel takes its section's colour.
    expect(card(page, 'land_policy')?.getAttribute('style')).toContain('var(--node-opaque)');
    expect(card(page, 'triage_policy')?.getAttribute('style')).toContain('var(--node-wait)');
  });

  test('a key this project sets that the pack does not declare is listed as such', async () => {
    const page = await settingsPage();
    const undeclared = [...page.querySelectorAll('[data-doc-section]')].find(
      section => section.querySelector('h2')?.textContent === 'Not declared by the pack'
    );
    expect(rows(undeclared)).toEqual(['size: large']);
  });

  test('an unreadable project file is said once, and each panel only says "Not read"', async () => {
    const page = await settingsPage({
      ...SETTINGS,
      projects: [{ ...web, error: '/repo/.archon/packs/acme.kit.yaml: not valid YAML' }],
    });
    const alerts = page.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.getAttribute('data-doc-panel')).toBe('panel');
    expect(alerts[0]?.textContent).toContain('/repo/.archon/packs/acme.kit.yaml: not valid YAML');
    expect(page.textContent?.split('not valid YAML')).toHaveLength(2);
    for (const name of ['triage_policy', 'land_policy', 'checks_file', 'validate_command'])
      expect(value(page, name)).toBe('Not read');
  });

  test('a pack that declares nothing says so', async () => {
    const page = await settingsPage({ ...SETTINGS, declaration: null, settings: [], projects: [] });
    expect(page.textContent).toContain('This pack declares no settings');
  });

  test('every state of the page is held to owner change 5: filled panels and headed sections', async () => {
    const states: FactoryPackSettings[] = [
      SETTINGS,
      { ...SETTINGS, mapErrors: ['The factory overview presents setting "gone"'] },
      { ...SETTINGS, projects: [{ ...web, error: 'not valid YAML', values: {} }] },
      { ...SETTINGS, projects: [api] },
      { ...SETTINGS, declaration: null, settings: [], projects: [] },
      {
        ...SETTINGS,
        declaration: { path: '/p/.pack/pack.yaml', error: 'not valid YAML' },
        sections: [],
        settings: [],
        projects: [],
      },
    ];
    for (const state of states) {
      const page = await settingsPage(state);
      expect(page.querySelector('[data-doc-page]')).not.toBeNull();
      expect(documentPageProblems(page)).toEqual([]);
      await unmount?.();
      unmount = undefined;
    }
  });

  test('a read that fails says so in a filled panel, not an outline box', async () => {
    globalThis.fetch = Object.assign(
      () => Promise.reject(new TypeError('connection refused')),
      originalFetch
    );
    try {
      const page = await mount(`/console/p/${ID}/factory/settings`);
      const alert = [...page.querySelectorAll('[role="alert"]')].find(node =>
        node.textContent?.includes("The pack's settings could not be read")
      );
      expect(alert?.getAttribute('data-doc-panel')).toBe('panel');
      expect(outlineBoxes(page)).toEqual([]);
    } finally {
      globalThis.fetch = silent;
    }
  });

  test('while the settings are read, the skeleton draws no outline-only box', async () => {
    // A read that never answers holds the page on its skeleton.
    const page = await mount(`/console/p/${ID}/factory/settings`);
    expect(page.querySelector('[data-skeleton="true"]')).not.toBeNull();
    expect(outlineBoxes(page)).toEqual([]);
  });
});
