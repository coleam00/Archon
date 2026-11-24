import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ChangeLookup, ChangeMergeState } from '@archon/adapters/forge-host';
import { getHomeWorkflowsPath } from '@archon/paths';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import type { DiscoveriesSource } from '@archon/workflows/factory-discoveries';
import type { ItemReadSource } from '@archon/workflows/item-read';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowItem, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { discoverWorkflows } from '@archon/workflows/workflow-discovery';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import {
  changeStateCache,
  discoveryCache,
  registerFactoryRoutes,
  type FactoryRouteDeps,
} from './api.factory';
import {
  factoryDiscoveriesResponseSchema,
  factoryItemDetailResponseSchema,
  factoryPackSettingsResponseSchema,
  factoryPacksResponseSchema,
  factoryProgressResponseSchema,
  factoryViewsSchema,
  factoryWorkflowSchema,
} from './schemas/factory.schemas';

const declaration = (pack: string, title: string): Record<string, unknown> => ({
  version: 1,
  pack,
  title,
  summary: 'Items in, changes out.',
  stages: [
    { id: 'build', label: 'Build', blurb: 'Builds.', group: 'build', workflows: ['deliver'] },
    { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
  ],
  placement: { 'deliver:ready': 'landed' },
  endings: {},
  landed: { stage: 'landed' },
  map: { cards: [{ stage: 'build' }], arrows: [] },
});

async function projectWith(
  track: (path: string) => string,
  files: Record<string, unknown>
): Promise<string> {
  const project = track(await mkdtemp(join(tmpdir(), 'archon-factory-route-')));
  for (const [path, content] of Object.entries(files)) {
    const file = join(project, ...path.split('/'));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return project;
}

/** Deps for a project with no items; each test replaces what it reads. */
const noItems: FactoryRouteDeps = {
  codebase: async () => null,
  codebases: async () => [],
  loadConfig: async () => ({
    assistant: undefined,
    commands: {},
    assistants: { claude: {}, codex: {} },
  }),
  ranWorkflows: async () => new Set(),
  itemsSource: {} as ItemReadSource,
  discoveriesSource: {} as DiscoveriesSource,
  changeMergeState: async () => {
    throw new Error('no change is looked up here');
  },
  discoverWorkflows: async () => {
    throw new Error('no workflow is discovered here');
  },
};

const PR7 = 'https://forge.example/acme/web/pull/7';
/** A forge audit row naming pull request 7 at `PR7`, the shape `pr.ready` records. */
const PR7_AUDIT = {
  integration: 'forge',
  operationId: 'op-1',
  operation: 'pr.ready',
  target: { repo: { host: 'forge.example', path: 'acme/web' }, number: 7 },
  plugin: { name: 'github', version: '1' },
  result: {
    operationId: 'op-1',
    ok: true,
    result: {
      op: 'pr.ready',
      value: {
        target: { repo: { host: 'forge.example', path: 'acme/web' }, number: 7 },
        outcome: 'applied',
        changed: true,
        pr: {
          repo: { host: 'forge.example', path: 'acme/web' },
          number: 7,
          schemaVersion: 1,
          url: PR7,
          head: 'feature',
          base: 'main',
          is_draft: false,
          state: 'open',
          head_repo: { host: 'forge.example', path: 'acme/web' },
          head_revision: 'a'.repeat(40),
          base_revision: 'b'.repeat(40),
          maintainer_can_modify: false,
        },
      },
    },
  },
  retries: 0,
  durationMs: 1,
};

describe('GET /api/factory/views', () => {
  const track = trackTempRoots();

  async function factoryApp(
    files: Record<string, unknown>,
    ran: string[] = []
  ): Promise<{ app: OpenAPIHono; project: string; asked: string[][] }> {
    const project = await projectWith(track, files);
    const asked: string[][] = [];
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebase: async id =>
        id === 'cb-1' ? { cwd: project, projectKey: 'acme/web', remote: null } : null,
      ranWorkflows: async (id, names) => {
        asked.push([id, ...names]);
        return new Set(ran);
      },
    });
    return { app, project, asked };
  }

  const views = async (app: OpenAPIHono): Promise<ReturnType<typeof factoryViewsSchema.parse>> => {
    const response = await app.request('/api/factory/views?codebaseId=cb-1');
    expect(response.status).toBe(200);
    return factoryViewsSchema.parse(await response.json());
  };

  test("a project's own file applies with no runs", async () => {
    const { app, project } = await factoryApp({
      '.archon/packs/acme.kit.factory-view.json': declaration('acme/kit', 'Kit factory'),
    });
    const listing = await views(app);
    expect(listing.views.map(v => [v.pack, v.source, v.path, v.declaration.title])).toEqual([
      [
        'acme/kit',
        'project-file',
        join(project, '.archon', 'packs', 'acme.kit.factory-view.json'),
        'Kit factory',
      ],
    ]);
  });

  test("a pack's own view applies only once the project ran a workflow it names", async () => {
    const files = {
      '.archon/workflows/factory/.shared/factory-view.json': declaration('factory', 'F'),
    };
    const unrun = await factoryApp(files);
    expect((await views(unrun.app)).views.find(v => v.pack === 'factory')).toBeUndefined();
    expect(unrun.asked).toEqual([['cb-1', 'deliver']]);

    const run = await factoryApp(files, ['deliver']);
    expect((await views(run.app)).views.find(v => v.pack === 'factory')?.source).toBe('project');
  });

  test('a malformed project file is listed under errors with its path', async () => {
    const { app, project } = await factoryApp({
      '.archon/packs/acme.kit.factory-view.json': '{ "version": ',
    });
    const listing = await views(app);
    const path = join(project, '.archon', 'packs', 'acme.kit.factory-view.json');
    expect(listing.views).toEqual([]);
    expect(listing.errors).toEqual([
      { pack: 'acme.kit', source: 'project-file', path, error: expect.stringContaining(path) },
    ]);
  });

  test('each view names its pack key and the run names of its workflows', async () => {
    const { app } = await factoryApp({
      '.archon/packs/acme.kit.factory-view.json': declaration('acme/kit', 'Kit factory'),
    });
    const [view] = (await views(app)).views;
    expect([view?.packKey, view?.runNames]).toEqual(['acme.kit', { deliver: 'acme/kit:deliver' }]);
  });

  test('an unknown codebase returns 404', async () => {
    const { app } = await factoryApp({});
    const response = await app.request('/api/factory/views?codebaseId=missing');
    expect(response.status).toBe(404);
  });
});

describe('GET /api/factory/packs', () => {
  const track = trackTempRoots();
  const viewFile = '.archon/packs/acme.kit.factory-view.json';
  const overviewFile = '.archon/packs/acme.kit.factory-overview.json';
  const overview = (pack: string, title: string): Record<string, unknown> => ({
    version: 1,
    pack,
    title,
    caption: 'Work comes in and lands.',
    root: 'top',
    views: {
      top: {
        cards: [
          { id: 'a', title: 'A', text: 'In.', icon: 'inbox', kind: 'input', col: 1, row: 1 },
          { id: 'b', title: 'B', text: 'Out.', icon: 'flag', kind: 'outcome', col: 2, row: 1 },
        ],
        edges: [
          { from: 'a', to: 'b', kind: 'feeds' },
          { from: 'b', to: 'a', kind: 'loops-back' },
        ],
      },
    },
  });

  async function read(
    projects: { id: string; name: string; files: Record<string, unknown>; config?: 'throws' }[]
  ): Promise<{ status: number; body: unknown; cwds: Map<string, string> }> {
    const cwds = new Map<string, string>();
    for (const project of projects) cwds.set(project.id, await projectWith(track, project.files));
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebases: async () =>
        projects.map(({ id, name }) => ({ id, name, cwd: cwds.get(id) ?? '' })),
      loadConfig: async cwd => {
        if (projects.find(p => cwds.get(p.id) === cwd)?.config === 'throws')
          throw new Error('config is broken');
        return noItems.loadConfig(cwd);
      },
    });
    const response = await app.request('/api/factory/packs');
    return { status: response.status, body: await response.json(), cwds };
  }

  test("the pack's own file wins, with no project named", async () => {
    // A global folder pack: the scratch home every test process starts with.
    const own = join(getHomeWorkflowsPath(), 'kit', '.shared', 'factory-overview.json');
    await mkdir(join(own, '..'), { recursive: true });
    await writeFile(own, JSON.stringify(overview('kit', "The pack's own")));
    try {
      const { status, body } = await read([
        {
          id: 'cb-1',
          name: 'web',
          files: { '.archon/packs/kit.factory-overview.json': overview('kit', 'Project') },
        },
      ]);
      expect(status).toBe(200);
      const [pack] = factoryPacksResponseSchema.parse(body).packs;
      expect([pack?.key, pack?.overview?.declaration.title, pack?.overview?.path]).toEqual([
        'kit',
        "The pack's own",
        own,
      ]);
      expect(pack?.readFrom).toBeNull();
    } finally {
      await removeTempTree(join(getHomeWorkflowsPath(), 'kit'));
    }
  });

  test('a project file is read from the first project by name, and the projects listed', async () => {
    const { body, cwds } = await read([
      {
        id: 'cb-2',
        name: 'zeta',
        files: {
          [viewFile]: declaration('acme/kit', 'Kit'),
          [overviewFile]: overview('acme/kit', 'Zeta'),
        },
      },
      {
        id: 'cb-1',
        name: 'alpha',
        files: {
          [viewFile]: declaration('acme/kit', 'Kit'),
          [overviewFile]: overview('acme/kit', 'Alpha'),
        },
      },
    ]);
    const packs = factoryPacksResponseSchema.parse(body);
    expect(packs.packs).toHaveLength(1);
    const [pack] = packs.packs;
    expect([pack?.pack, pack?.key, pack?.overview?.declaration.title]).toEqual([
      'acme/kit',
      'acme.kit',
      'Alpha',
    ]);
    expect(pack?.overview?.path).toBe(
      join(cwds.get('cb-1') ?? '', '.archon', 'packs', 'acme.kit.factory-overview.json')
    );
    expect(pack?.readFrom).toEqual({ codebaseId: 'cb-1', name: 'alpha' });
    expect(pack?.projects).toEqual([
      { codebaseId: 'cb-1', name: 'alpha' },
      { codebaseId: 'cb-2', name: 'zeta' },
    ]);
  });

  test('a project that cannot be read is listed, and the other packs remain', async () => {
    const { status, body } = await read([
      { id: 'cb-1', name: 'broken', files: {}, config: 'throws' },
      { id: 'cb-2', name: 'web', files: { [overviewFile]: overview('acme/kit', 'Kit') } },
    ]);
    expect(status).toBe(200);
    const packs = factoryPacksResponseSchema.parse(body);
    expect(packs.packs.map(p => p.readFrom?.name)).toEqual(['web']);
    expect(packs.unreadProjects).toEqual([
      { codebaseId: 'cb-1', name: 'broken', error: 'config is broken' },
    ]);
  });
});

describe('GET /api/factory/pack-settings', () => {
  const track = trackTempRoots();
  const overview = {
    version: 1,
    pack: 'kit',
    title: 'Kit',
    caption: 'Work comes in and lands.',
    root: 'top',
    views: {
      top: {
        cards: [
          { id: 'a', title: 'A', text: 'In.', icon: 'inbox', kind: 'input', col: 1, row: 1 },
          { id: 'b', title: 'B', text: 'Out.', icon: 'flag', kind: 'outcome', col: 2, row: 1 },
        ],
        edges: [
          { from: 'a', to: 'b', kind: 'feeds' },
          { from: 'b', to: 'a', kind: 'loops-back' },
        ],
      },
    },
    settings: {
      land_policy: { points_to: 'policy', shadow: true, section: 'ahead', when_live: 'Would land' },
    },
    setting_sections: [
      {
        id: 'ahead',
        eyebrow: 'Gates',
        title: 'What may go ahead',
        kind: 'gate' as const,
        icon: 'gavel' as const,
      },
    ],
  };

  async function read(query: string): Promise<{ status: number; body: unknown; cwd: string }> {
    const cwd = await projectWith(track, {
      '.archon/packs/kit.factory-view.json': declaration('kit', 'Kit factory'),
      '.archon/packs/kit.yaml': 'settings:\n  land_policy: docs/land.md\n  colour: red\n',
      'docs/land.md': '# Land',
    });
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebases: async () => [{ id: 'cb-1', name: 'web', cwd }],
    });
    const response = await app.request(`/api/factory/pack-settings?pack=${query}`);
    return { status: response.status, body: await response.json(), cwd };
  }

  test("reads a home pack's declaration and each project's values", async () => {
    // A global folder pack: the scratch home every test process starts with.
    const pack = join(getHomeWorkflowsPath(), 'kit');
    await mkdir(join(pack, '.pack'), { recursive: true });
    await mkdir(join(pack, '.shared'), { recursive: true });
    await writeFile(
      join(pack, '.pack', 'pack.yaml'),
      'inputs:\n  land_policy:\n    default: ""\n    description: Shadow only.\n  command: {}\n'
    );
    await writeFile(join(pack, '.shared', 'factory-overview.json'), JSON.stringify(overview));
    try {
      const { status, body } = await read('kit');
      expect(status).toBe(200);
      const settings = factoryPackSettingsResponseSchema.parse(body);
      expect(settings.declaration).toEqual({ path: join(pack, '.pack', 'pack.yaml'), error: null });
      expect(
        settings.settings.map(s => [s.name, s.shadow, s.pointsTo, s.section, s.whenLive])
      ).toEqual([
        ['land_policy', true, 'policy', 'ahead', 'Would land'],
        ['command', false, null, null, null],
      ]);
      expect(settings.sections).toEqual(overview.setting_sections);
      const [project] = settings.projects;
      expect(project?.name).toBe('web');
      const land = project?.values.land_policy;
      expect(land?.state === 'set' ? [land.file?.display, land.file?.status] : null).toEqual([
        'docs/land.md',
        'found',
      ]);
      expect(project?.undeclared).toEqual([{ name: 'colour', value: 'red' }]);
    } finally {
      await removeTempTree(pack);
    }
  });

  test('a key no pack with an overview has is 404', async () => {
    expect((await read('nope')).status).toBe(404);
  });
});

describe('GET /api/factory/discoveries', () => {
  const track = trackTempRoots();
  const viewFile = '.archon/packs/acme.kit.factory-view.json';
  const discoveries = {
    workflow: 'discoveries',
    shadow: true,
    filed: '/filed',
    held: '/held',
    dropped: '/dropped',
    entry: { title: '/title', kind: '/kind' },
  };
  // A shadow drain is declared a shadow step too; the two must agree.
  const shadows = [
    {
      workflow: 'discoveries',
      node: 'drain',
      label: 'What it would file',
      reads: 'lists',
      lists: [{ pointer: '/filed', words: 'would file' }],
    },
  ];
  // One item, one drain: no other source of the store is read.
  const item: WorkflowItem = { id: 'i-1', projectKey: 'acme/web', key: '1' };
  const drain = {
    id: 'd-1',
    workflow_name: 'acme/kit:discoveries',
    status: 'completed',
    metadata: {},
    started_at: new Date('2026-11-17T10:00:00Z'),
    completed_at: new Date('2026-11-17T10:05:00Z'),
  } as unknown as WorkflowRun;
  const drained: WorkflowEventRow = {
    id: 'd-1-completed',
    workflow_run_id: 'd-1',
    event_type: 'workflow_completed',
    step_index: null,
    step_name: null,
    data: {
      terminal_record: {
        run_id: 'd-1',
        status: 'completed',
        outcome: null,
        completed_outcome: null,
        error: null,
        first_failed_node: null,
        nodes: [],
        returns: {
          availability: 'available',
          node_id: 'drain',
          value: {
            filed: [{ title: 'A finding', kind: 'defect' }],
            held: [{ what: 'x', until: 'y' }],
            dropped: [],
          },
        },
        artifacts: { root: null, files: [], limitations: [] },
      },
    },
    created_at: '2026-11-17T10:05:00Z',
    event_order: 1,
  };
  const source = {
    listItemsInWindow: async () => [item],
    getItemRuns: async () => ({ item, runs: [drain], descendantIds: [] }),
    listEventsForRuns: async () => new Map([['d-1', [drained]]]),
  } as unknown as DiscoveriesSource;

  async function request(
    files: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const project = await projectWith(track, files);
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebase: async id =>
        id === 'cb-1' ? { cwd: project, projectKey: 'acme/web', remote: null } : null,
      discoveriesSource: source,
    });
    const response = await app.request('/api/factory/discoveries?codebaseId=cb-1');
    return { status: response.status, body: await response.json() };
  }

  test('what the drains decided, at the pointers the view declares', async () => {
    const { status, body } = await request({
      [viewFile]: { ...declaration('acme/kit', 'Kit factory'), discoveries, shadows },
    });
    expect(status).toBe(200);
    const read = factoryDiscoveriesResponseSchema.parse(body);
    expect(read).toMatchObject({ pack: 'acme/kit', shadow: true, held: 1, dropped: 0 });
    expect(read.findings.map(f => [f.title, f.kind, f.from.key, f.coveredBy])).toEqual([
      ['A finding', 'defect', '1', null],
    ]);
  });

  test('a view that declares no discoveries, and a project no view applies to, are 404', async () => {
    const without = await request({ [viewFile]: declaration('acme/kit', 'Kit factory') });
    expect(without).toEqual({
      status: 404,
      body: { error: 'This factory view declares no discoveries' },
    });
    expect((await request({})).status).toBe(404);
  });
});

describe('GET /api/factory/progress and /api/factory/item', () => {
  const track = trackTempRoots();
  const items: [WorkflowItem, WorkflowItem, WorkflowItem] = [
    { id: 'item-a', projectKey: 'acme/web', key: '1' },
    { id: 'item-b', projectKey: 'acme/web', key: '2' },
    { id: 'item-c', projectKey: 'acme/web', key: '3' },
  ];
  const run = (id: string, item: WorkflowItem, fields: Partial<WorkflowRun>): WorkflowRun => ({
    origin: null,
    id,
    workflow_name: 'acme/kit:deliver',
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status: 'completed',
    outcome: null,
    completed_outcome: 'ready',
    user_message: '',
    metadata: { inputs: { item: `#${item.key} Item ${item.key}\n\nThe body.` } },
    active_phase_started_at: null,
    started_at: new Date('2026-11-16T10:00:00Z'),
    completed_at: new Date('2026-11-16T10:30:00Z'),
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: item.id,
    ...fields,
  });
  const runs: Record<string, WorkflowRun[]> = {
    '1': [run('run-a', items[0], {})],
    '2': [
      run('run-b', items[1], { status: 'running', completed_at: null, completed_outcome: null }),
    ],
    // A deliver whose result names an empty change URL.
    '3': [run('run-c', items[2], {})],
  };
  const CHANGE = 'https://forge.example/acme/web/pull/7';
  const BRANCH_CHANGE = 'https://forge.example/acme/web/pull/8';
  const REMOTE = 'https://forge.example/acme/web.git';
  /** The terminal record a completed run records, its declared result naming `change`. */
  const completed = (runId: string, change: string, order: number): WorkflowEventRow => ({
    id: `${runId}-completed`,
    workflow_run_id: runId,
    event_type: 'workflow_completed',
    step_index: null,
    step_name: null,
    data: {
      terminal_record: {
        run_id: runId,
        status: 'completed',
        outcome: null,
        completed_outcome: 'ready',
        error: null,
        first_failed_node: null,
        nodes: [],
        returns: { availability: 'available', node_id: 'result', value: { change } },
        artifacts: { root: null, files: [], limitations: [] },
      },
    },
    created_at: '2026-11-16T10:30:00Z',
    event_order: order,
  });
  const events: WorkflowEventRow[] = [
    // The shape a completed run records: its terminal record carries the declared result.
    completed('run-a', CHANGE, 9),
    completed('run-c', '', 9),
    {
      // A forge audit row naming the pull request, the shape `pr.ready` records.
      id: 'e0-audit',
      workflow_run_id: 'run-a',
      event_type: 'integration_operation',
      step_index: null,
      step_name: null,
      data: PR7_AUDIT,
      created_at: '2026-11-16T10:29:00Z',
      event_order: 8,
    },
    {
      id: 'e1',
      workflow_run_id: 'run-b',
      event_type: 'node_started',
      step_index: null,
      step_name: 'build',
      data: {},
      created_at: '2026-11-16T11:00:00Z',
      event_order: 1,
    },
  ];
  const source: ItemReadSource = {
    // The branch each run recorded, as the host reads it from the run's isolation record.
    branchOf: async run => `branch-${run.id}`,
    store: {
      getItemRuns: async (projectKey, key) => {
        const item = items.find(entry => entry.key === key && entry.projectKey === projectKey);
        return item ? { item, runs: runs[key] ?? [], descendantIds: [] } : null;
      },
      listEventsForRuns: async ids =>
        new Map(ids.map(id => [id, events.filter(row => row.workflow_run_id === id)])),
      listAttentionQueueRows: async () => [],
      getWorkflowRun: async () => null,
      getWorkflowRunForAttention: async () => null,
      getCodebase: async () => null,
      getItem: async () => null,
      getItemMerge: async () => null,
      getItemLanding: async () => null,
      listOpenItemWaits: async () => [],
      listSkippedItemStarts: async itemIds => new Map(itemIds.map(id => [id, []])),
      listQueuedItemStarts: async itemIds => new Map(itemIds.map(id => [id, []])),
      getInstallHold: async () => null,
      getRunLimit: async () => null,
      listHeldItemStarts: async () => [],
      listItemAsks: async () => [],
      listItemRulings: async () => [],
      listItemLinks: async () => [],
      getResourceStartRequest: async () => null,
      listStartReceiptSources: async () => new Map(),
    },
  };

  async function itemsApp(
    files: Record<string, unknown>,
    lookups: unknown[] = [],
    branchesSeen: string[][] = []
  ): Promise<OpenAPIHono> {
    const project = await projectWith(track, files);
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebase: async id =>
        id === 'cb-1' ? { cwd: project, projectKey: 'acme/web', remote: REMOTE } : null,
      itemsSource: source,
      changeMergeState: async (lookup, branches) => {
        lookups.push(lookup.kind === 'url' ? lookup.url : lookup);
        branchesSeen.push([...(await branches())]);
        return lookup.kind === 'url'
          ? // No number from the forge: the one the run's audit row names stands.
            { url: null, merged: true, mergedAt: '2026-11-17T01:00:00Z', number: null }
          : { url: BRANCH_CHANGE, merged: false, mergedAt: null, number: 8 };
      },
    });
    return app;
  }
  const withView = {
    '.archon/packs/acme.kit.factory-view.json': {
      ...declaration('acme/kit', 'Kit factory'),
      itemTitle: { input: 'item' },
      change: { workflow: 'deliver', pointer: '/change' },
    },
  };

  test('the progress of each key asked, repeated or one; a key with no item is left out', async () => {
    const app = await itemsApp(withView);
    const response = await app.request('/api/factory/progress?codebaseId=cb-1&keys=2&keys=9');
    expect(response.status).toBe(200);
    const read = factoryProgressResponseSchema.parse(await response.json());
    expect(read.pack).toBe('acme/kit');
    expect(read.progress).toEqual({
      '2': {
        title: 'Item 2',
        running: {
          runId: 'run-b',
          workflow: 'deliver',
          step: 'build',
          startedAt: '2026-11-16T10:00:00.000Z',
        },
        round: null,
        partOf: null,
        returned: 0,
        change: null,
        runs: [{ runId: 'run-b', workflow: 'deliver', failedStep: null }],
        shadows: [],
        parked: null,
        awaits: null,
      },
    });
    expect(read.members).toEqual({ '2': [] });
    const one = await app.request('/api/factory/progress?codebaseId=cb-1&keys=1');
    const single = factoryProgressResponseSchema.parse(await one.json());
    expect(Object.keys(single.progress)).toEqual(['1']);
  });

  test('a change is looked up once across requests, through the cache the route shares', async () => {
    const lookups: unknown[] = [];
    const branchesSeen: string[][] = [];
    const app = await itemsApp(withView, lookups, branchesSeen);
    for (let request = 0; request < 2; request++) {
      const response = await app.request('/api/factory/progress?codebaseId=cb-1&keys=1&keys=2');
      const read = factoryProgressResponseSchema.parse(await response.json());
      expect(read.progress['1']?.change).toEqual({
        url: CHANGE,
        merged: true,
        mergedAt: '2026-11-17T01:00:00Z',
        // Named by the run's own forge audit row.
        number: 7,
      });
    }
    expect(lookups).toEqual([CHANGE]);
    // The lookup is handed the item's runs' recorded branches, for a change no audit row names.
    expect(branchesSeen).toEqual([['branch-run-a']]);
  });

  test("both routes hand an item's recorded merge to the cache: merged as recorded, the forge never asked", async () => {
    const lookups: unknown[] = [];
    const app = await itemsApp(withView, lookups);
    const item = items.find(entry => entry.key === '1');
    if (item === undefined) throw new Error('item 1 is in the fixture');
    const at = '2026-11-17T02:00:00.000Z';
    const read = source.store.getItemMerge;
    source.store.getItemMerge = async id =>
      id === item.id
        ? { change: CHANGE, commit: null, at, recordedAt: at, via: 'cli', fromRun: null }
        : null;
    try {
      // The run's audit row names PR 7, so not even the background number lookup runs.
      const recorded = { url: CHANGE, merged: true, mergedAt: at, number: 7 };
      const progress = await app.request('/api/factory/progress?codebaseId=cb-1&keys=1');
      expect(
        factoryProgressResponseSchema.parse(await progress.json()).progress['1']?.change
      ).toEqual(recorded);
      const detail = await app.request('/api/factory/item?codebaseId=cb-1&key=1');
      expect(
        factoryItemDetailResponseSchema.parse(await detail.json()).item.progress?.change
      ).toEqual(recorded);
      expect(lookups).toEqual([]);
    } finally {
      source.store.getItemMerge = read;
    }
  });

  test("an empty change URL: the PR the forge finds on the item's branches in the project's remote", async () => {
    const lookups: unknown[] = [];
    const branchesSeen: string[][] = [];
    const app = await itemsApp(withView, lookups, branchesSeen);
    const response = await app.request('/api/factory/progress?codebaseId=cb-1&keys=3');
    const read = factoryProgressResponseSchema.parse(await response.json());
    expect(read.progress['3']?.change).toEqual({
      url: BRANCH_CHANGE,
      merged: false,
      mergedAt: null,
      number: 8,
    });
    expect(lookups).toEqual([{ kind: 'branch', remote: REMOTE }]);
    expect(branchesSeen).toEqual([['branch-run-c']]);
  });

  test('no keys, or more keys than a window page holds, is a 400', async () => {
    const app = await itemsApp(withView);
    expect((await app.request('/api/factory/progress?codebaseId=cb-1')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `keys=${String(i)}`).join('&');
    expect((await app.request(`/api/factory/progress?codebaseId=cb-1&${many}`)).status).toBe(400);
  });

  test('no applying view, or an unknown codebase, is a 404', async () => {
    const app = await itemsApp({});
    const none = await app.request('/api/factory/progress?codebaseId=cb-1&keys=1');
    expect(none.status).toBe(404);
    expect((await app.request('/api/factory/progress?codebaseId=missing&keys=1')).status).toBe(404);
  });
  test("one item: its read and progress, with each run's story facts", async () => {
    const app = await itemsApp(withView);
    const response = await app.request('/api/factory/item?codebaseId=cb-1&key=2');
    expect(response.status).toBe(200);
    const detail = factoryItemDetailResponseSchema.parse(await response.json());
    expect(detail.pack).toBe('acme/kit');
    expect(detail.item.item.key).toBe('2');
    expect(detail.item.progress?.running?.step).toBe('build');
    expect(detail.runs).toEqual([
      {
        runId: 'run-b',
        workflow: 'deliver',
        costUsd: null,
        step: 'build',
        rounds: null,
        shadows: [],
        // Still running: no change named and nothing said yet; its one step start.
        change: null,
        said: null,
        models: [],
        steps: [{ node: 'build', startedAt: '2026-11-16T11:00:00.000Z' }],
      },
    ]);
  });

  test('the item route shares the merge cache with the progress route', async () => {
    const lookups: unknown[] = [];
    const app = await itemsApp(withView, lookups);
    await app.request('/api/factory/progress?codebaseId=cb-1&keys=1');
    const response = await app.request('/api/factory/item?codebaseId=cb-1&key=1');
    const detail = factoryItemDetailResponseSchema.parse(await response.json());
    expect(detail.item.progress?.change?.merged).toBe(true);
    expect(lookups).toEqual([CHANGE]);
  });

  test('a missing key is a 400; an unknown item, codebase or no applying view is a 404', async () => {
    const app = await itemsApp(withView);
    expect((await app.request('/api/factory/item?codebaseId=cb-1')).status).toBe(400);
    expect((await app.request('/api/factory/item?codebaseId=cb-1&key=9')).status).toBe(404);
    expect((await app.request('/api/factory/item?codebaseId=missing&key=1')).status).toBe(404);
    const viewless = await itemsApp({});
    expect((await viewless.request('/api/factory/item?codebaseId=cb-1&key=1')).status).toBe(404);
  });
});

describe('the merge-state cache', () => {
  const CHANGE = 'https://forge.example/acme/web/pull/7';
  const noBranches = async (): Promise<string[]> => [];
  const change = { kind: 'url' as const, url: CHANGE, audits: [] };
  const settle = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  test('one lookup in flight per change; its answer serves the next request', async () => {
    let lookups = 0;
    const state = changeStateCache({
      changeMergeState: async () => {
        lookups++;
        return { url: null, merged: false, mergedAt: null, number: null };
      },
    });
    const both = await Promise.all([
      state(change, noBranches, null, null),
      state(change, noBranches, null, null),
    ]);
    // The run's URL is shown, whatever the forge's answer names.
    expect(both).toEqual([
      { url: CHANGE, merged: false, mergedAt: null, number: null },
      { url: CHANGE, merged: false, mergedAt: null, number: null },
    ]);
    await state(change, noBranches, null, null);
    expect(lookups).toBe(1);
  });

  test('a slow first lookup answers pending within the wait, uncached, then fills the cache', async () => {
    let finish: (value: ChangeMergeState) => void = () => {};
    const state = changeStateCache({
      changeStateWaitMs: 10,
      changeMergeState: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    });
    expect(await state(change, noBranches, null, null)).toEqual({
      url: CHANGE,
      merged: 'pending',
      mergedAt: null,
      number: null,
    });
    // Still running: the next read waits on the same lookup and answers pending again.
    expect((await state(change, noBranches, null, null)).merged).toBe('pending');
    finish({ url: CHANGE, merged: true, mergedAt: '2026-11-17T01:00:00Z', number: 7 });
    await settle();
    expect(await state(change, noBranches, null, null)).toEqual({
      url: CHANGE,
      merged: true,
      mergedAt: '2026-11-17T01:00:00Z',
      number: 7,
    });
  });

  test('an answer a minute old is served while it refreshes; a merge is kept', async () => {
    let clock = 0;
    let lookups = 0;
    const state = changeStateCache({
      now: () => clock,
      changeMergeState: async () =>
        lookups++ === 0
          ? { url: null, merged: false, mergedAt: null, number: null }
          : { url: CHANGE, merged: true, mergedAt: '2026-11-17T01:00:00Z', number: 7 },
    });
    expect((await state(change, noBranches, null, null)).merged).toBe(false);
    clock = 59_999;
    expect((await state(change, noBranches, null, null)).merged).toBe(false);
    expect(lookups).toBe(1);
    clock = 60_000;
    expect((await state(change, noBranches, null, null)).merged).toBe(false);
    await settle();
    expect((await state(change, noBranches, null, null)).merged).toBe(true);
    clock = 10_000_000;
    await state(change, noBranches, null, null);
    expect(lookups).toBe(2);
  });

  test('a lookup that throws answers unknown, never rejects, and is cached', async () => {
    let lookups = 0;
    const state = changeStateCache({
      changeMergeState: async () => {
        lookups++;
        throw new Error('offline');
      },
    });
    expect(await state(change, noBranches, null, null)).toEqual({
      url: CHANGE,
      merged: 'unknown',
      mergedAt: null,
      number: null,
    });
    expect((await state(change, noBranches, null, null)).merged).toBe('unknown');
    expect(lookups).toBe(1);
  });

  test('runs that named no URL get an answer each, asked in the remote they are given', async () => {
    const asked: ChangeLookup[] = [];
    const state = changeStateCache({
      changeMergeState: async lookup => {
        asked.push(lookup);
        const number = asked.length === 1 ? 8 : 9;
        return { url: `${CHANGE.slice(0, -1)}${number}`, merged: true, mergedAt: null, number };
      },
    });
    const branches = async (): Promise<string[]> => ['a'];
    const first = await state({ kind: 'branch', run: 'run-1' }, branches, 'remote-1', null);
    const second = await state({ kind: 'branch', run: 'run-2' }, branches, 'remote-1', null);
    expect([first.number, second.number]).toEqual([8, 9]);
    expect(first.url).toBe(`${CHANGE.slice(0, -1)}8`);
    expect((await state({ kind: 'branch', run: 'run-1' }, branches, 'remote-1', null)).number).toBe(
      8
    );
    expect(asked).toEqual([
      { kind: 'branch', remote: 'remote-1' },
      { kind: 'branch', remote: 'remote-1' },
    ]);
  });

  const recorded = { change: CHANGE, at: '2026-11-17T01:00:00.000Z' };
  const fromRecord = { url: CHANGE, merged: true, mergedAt: recorded.at };

  test('a recorded merge whose audit rows name its pull request never asks the change host', async () => {
    let lookups = 0;
    const state = changeStateCache({
      changeMergeState: async () => {
        lookups++;
        return { url: null, merged: false, mergedAt: null, number: null };
      },
    });
    const audited = { ...change, audits: [PR7_AUDIT] };
    expect(await state(audited, noBranches, null, recorded)).toEqual({ ...fromRecord, number: 7 });
    expect(lookups).toBe(0);
  });

  test('a recorded merge answers at once; its number alone is asked for once, in the background', async () => {
    let lookups = 0;
    let finish: (value: ChangeMergeState) => void = () => {};
    const state = changeStateCache({
      // The wait would answer pending; a recorded merge never waits on it.
      changeStateWaitMs: 60_000,
      changeMergeState: () => {
        lookups++;
        return new Promise(resolve => {
          finish = resolve;
        });
      },
    });
    expect(await state(change, noBranches, null, recorded)).toEqual({
      ...fromRecord,
      number: null,
    });
    expect(await state(change, noBranches, null, recorded)).toEqual({
      ...fromRecord,
      number: null,
    });
    expect(lookups).toBe(1);
    // The host answers with the pull request's number; whatever it says of the merge, the
    // record holds.
    finish({ url: CHANGE, merged: false, mergedAt: null, number: 9 });
    await settle();
    expect(await state(change, noBranches, null, recorded)).toEqual({ ...fromRecord, number: 9 });
    expect(lookups).toBe(1);
  });

  test('a recorded merge takes no number from another pull request the host found', async () => {
    let lookups = 0;
    const state = changeStateCache({
      changeMergeState: async () => {
        lookups++;
        return { url: `${CHANGE}0`, merged: true, mergedAt: null, number: 70 };
      },
    });
    const branch = { kind: 'branch' as const, run: 'run-1' };
    expect(await state(branch, noBranches, 'remote-1', recorded)).toEqual({
      ...fromRecord,
      number: null,
    });
    await settle();
    expect(await state(branch, noBranches, 'remote-1', recorded)).toEqual({
      ...fromRecord,
      number: null,
    });
    expect(lookups).toBe(1);
  });

  test('a slow branch lookup answers pending with no URL yet', async () => {
    const state = changeStateCache({
      changeStateWaitMs: 10,
      changeMergeState: () => new Promise(() => {}),
    });
    expect(await state({ kind: 'branch', run: 'run-1' }, noBranches, null, null)).toEqual({
      url: null,
      merged: 'pending',
      mergedAt: null,
      number: null,
    });
  });
});

describe('the stage graph discovery cache', () => {
  const found = (name: string): WorkflowLoadResult =>
    ({ workflows: [{ workflow: { name } }], errors: [] }) as unknown as WorkflowLoadResult;
  const settle = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  test('concurrent reads share one discovery, and its result serves the next read', async () => {
    let discoveries = 0;
    const workflows = discoveryCache({
      discoverWorkflows: async () => {
        discoveries++;
        return found('deliver');
      },
    });
    await Promise.all([workflows('/repo'), workflows('/repo')]);
    await workflows('/repo');
    expect(discoveries).toBe(1);
    // Another checkout is its own entry.
    await workflows('/other');
    expect(discoveries).toBe(2);
  });

  test('an old result is served while a refresh runs; the next read gets the refresh', async () => {
    let clock = 0;
    let discoveries = 0;
    const workflows = discoveryCache({
      now: () => clock,
      discoverWorkflows: async () => found(discoveries++ === 0 ? 'old' : 'new'),
    });
    expect((await workflows('/repo')).workflows[0]?.workflow.name).toBe('old');
    clock = 29_999;
    await workflows('/repo');
    expect(discoveries).toBe(1);
    clock = 30_000;
    expect((await workflows('/repo')).workflows[0]?.workflow.name).toBe('old');
    await settle();
    expect(discoveries).toBe(2);
    expect((await workflows('/repo')).workflows[0]?.workflow.name).toBe('new');
  });

  test('a failed discovery is not kept; a failed refresh keeps the last result', async () => {
    let clock = 0;
    let fail = true;
    let discoveries = 0;
    const workflows = discoveryCache({
      now: () => clock,
      discoverWorkflows: async () => {
        discoveries++;
        if (fail) throw new Error('disk busy');
        return found('deliver');
      },
    });
    await expect(workflows('/repo')).rejects.toThrow('disk busy');
    await settle();
    fail = false;
    expect((await workflows('/repo')).workflows).toHaveLength(1);
    expect(discoveries).toBe(2);
    fail = true;
    clock = 60_000;
    expect((await workflows('/repo')).workflows).toHaveLength(1);
    await settle();
    expect(discoveries).toBe(3);
    expect((await workflows('/repo')).workflows).toHaveLength(1);
  });
});

describe('GET /api/factory/workflow', () => {
  const track = trackTempRoots();
  const DELIVER = [
    'name: deliver',
    'description: Delivers.',
    'nodes:',
    '  - id: rounds',
    '    loop_group:',
    '      max_iterations: 2',
    '      until_bash: "true"',
    '      nodes:',
    '        - id: fix',
    '          bash: echo fixed',
    '',
  ].join('\n');

  async function workflowApp(withWorkflow = true): Promise<OpenAPIHono> {
    const project = await projectWith(track, {
      '.archon/packs/kit.factory-view.json': declaration('kit', 'Kit factory'),
      ...(withWorkflow ? { '.archon/workflows/kit/deliver/deliver.yaml': DELIVER } : {}),
    });
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebase: async id =>
        id === 'cb-1' ? { cwd: project, projectKey: 'acme/web', remote: null } : null,
      discoverWorkflows: cwd =>
        discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false }),
    });
    return app;
  }

  test("returns the steps of a workflow the project's view names", async () => {
    const response = await (await workflowApp()).request(
      '/api/factory/workflow?codebaseId=cb-1&workflow=deliver'
    );
    expect(response.status).toBe(200);
    const body = factoryWorkflowSchema.parse(await response.json());
    expect([body.name, body.runName]).toEqual(['deliver', 'deliver']);
    expect(body.groups.map(g => [g.id, g.kind, g.maxRounds])).toEqual([['rounds', 'loop', 2]]);
    expect(body.steps.map(s => [s.key, s.kind, s.yaml])).toEqual([
      ['rounds.fix', 'bash', 'id: fix\nbash: echo fixed'],
    ]);
  });

  test('a workflow no applying view names returns 404', async () => {
    const response = await (await workflowApp()).request(
      '/api/factory/workflow?codebaseId=cb-1&workflow=other'
    );
    expect(response.status).toBe(404);
  });

  test('a workflow the view names but the project lacks returns 404 naming the pack', async () => {
    const response = await (await workflowApp(false)).request(
      '/api/factory/workflow?codebaseId=cb-1&workflow=deliver'
    );
    expect(response.status).toBe(404);
    const { error } = (await response.json()) as { error: string };
    // Read by a person on a stage: it names the pack and the workflow.
    expect(error).toContain('kit');
    expect(error).toContain('deliver');
  });

  /** The kit view listing `deliver` and `next` in Build, with `next` on disk and not `deliver`. */
  async function twoWorkflowApp(retired: string[] | undefined): Promise<OpenAPIHono> {
    const view = declaration('kit', 'Kit factory');
    const project = await projectWith(track, {
      '.archon/packs/kit.factory-view.json': {
        ...view,
        stages: [
          {
            id: 'build',
            label: 'Build',
            blurb: 'Builds.',
            group: 'build',
            workflows: ['deliver', 'next'],
          },
          { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
        ],
        ...(retired === undefined ? {} : { retired }),
      },
      '.archon/workflows/kit/next/next.yaml': DELIVER.replace('name: deliver', 'name: next'),
    });
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebase: async () => ({ cwd: project, projectKey: 'acme/web', remote: null }),
      discoverWorkflows: cwd =>
        discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false }),
    });
    return app;
  }

  const missingError = async (app: OpenAPIHono): Promise<[number, string]> => {
    const response = await app.request('/api/factory/workflow?codebaseId=cb-1&workflow=deliver');
    const { error } = (await response.json()) as { error: string };
    return [response.status, error];
  };

  test('a retired workflow returns 404 saying the pack has no such workflow', async () => {
    const app = await twoWorkflowApp(['deliver']);
    expect(await missingError(app)).toEqual([
      404,
      'This pack has no workflow named deliver. It was retired; the items it worked still show their runs.',
    ]);
  });

  test('a workflow missing from a pack whose other workflows are here returns 404 saying so, not that the pack is missing', async () => {
    const app = await twoWorkflowApp(undefined);
    expect(await missingError(app)).toEqual([404, 'This pack has no workflow named deliver.']);
  });

  test('reads share one discovery; a workflow missing from it is discovered again before the 404', async () => {
    const project = await projectWith(track, {
      '.archon/packs/kit.factory-view.json': declaration('kit', 'Kit factory'),
    });
    let discoveries = 0;
    const app = new OpenAPIHono();
    registerFactoryRoutes(app, {
      ...noItems,
      codebase: async () => ({ cwd: project, projectKey: 'acme/web', remote: null }),
      discoverWorkflows: cwd => {
        discoveries++;
        return discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false });
      },
    });
    const read = (): Promise<Response> =>
      Promise.resolve(app.request('/api/factory/workflow?codebaseId=cb-1&workflow=deliver'));
    expect((await read()).status).toBe(404);
    // The pack is installed after the 404, and the person reloads as it told them to.
    await mkdir(join(project, '.archon/workflows/kit/deliver'), { recursive: true });
    await writeFile(join(project, '.archon/workflows/kit/deliver/deliver.yaml'), DELIVER);
    discoveries = 0;
    expect((await read()).status).toBe(200);
    expect(discoveries).toBe(1);
    expect((await Promise.all([read(), read()])).map(response => response.status)).toEqual([
      200, 200,
    ]);
    expect(discoveries).toBe(1);
  });

  test('an unknown codebase returns 404', async () => {
    const response = await (await workflowApp()).request(
      '/api/factory/workflow?codebaseId=missing&workflow=deliver'
    );
    expect(response.status).toBe(404);
  });
});
