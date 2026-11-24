import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as bundleInventory from './defaults/bundle-inventory';
import {
  findPackDeclaration,
  readFactoryPackSettings,
  type FactoryPackSettings,
  type FoundPackDeclaration,
} from './factory-pack-settings';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import type { FactoryOverview } from './schemas/factory-overview';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

const track = trackTempRoots();
const indexSpy = spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
afterAll(() => {
  indexSpy.mockRestore();
});

let root: string;
let roots: LiveWorkflowSourceRoots;

beforeEach(async () => {
  root = track(await mkdtemp(join(tmpdir(), 'archon-factory-pack-settings-')));
  roots = {
    kind: 'live',
    config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    project: null,
    globalWorkflows: join(root, 'home', 'workflows'),
    globalCommands: join(root, 'home', 'commands'),
    globalScripts: join(root, 'home', 'scripts'),
    bundledWorkflows: join(root, 'bundled'),
    installed: { kind: 'receipts', pluginsDir: join(root, 'home', 'plugins') },
  };
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** A global folder pack `kit` declaring `yaml` as its `.pack/pack.yaml`. */
const declare = (yaml: string): Promise<void> =>
  write(join(roots.globalWorkflows, 'kit', '.pack', 'pack.yaml'), yaml);

const DECLARATION = [
  'inputs:',
  '  zeta_policy:',
  '    description: Path to the zeta policy. Shadow only for now.',
  '    default: ""',
  '  alpha_policy:',
  '    description: Path to the alpha policy.',
  '  checks_file:',
  '    default: ""',
  '  command:',
  '    default: make test',
  '',
].join('\n');

/** A project checkout whose `.archon/packs/kit.yaml` holds `settings`, plus `files`. */
async function project(
  name: string,
  settings: string | null,
  files: Record<string, string> = {}
): Promise<{ codebaseId: string; name: string; cwd: string }> {
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  if (settings !== null) await write(join(cwd, '.archon', 'packs', 'kit.yaml'), settings);
  for (const [path, content] of Object.entries(files)) await write(join(cwd, path), content);
  return { codebaseId: `cb-${name}`, name, cwd };
}

async function declared(): Promise<FoundPackDeclaration> {
  await declare(DECLARATION);
  const found = await findPackDeclaration(roots, 'kit');
  if (found === null) throw new Error('kit declares nothing');
  return found;
}

const MAP = {
  zeta_policy: {
    points_to: 'policy' as const,
    shadow: true,
    section: 'held',
    when_live: 'Would act on it',
  },
  alpha_policy: { points_to: 'policy' as const, section: 'held' },
  checks_file: { points_to: 'checks' as const, shadow: true },
};

async function read(
  projects: Awaited<ReturnType<typeof project>>[],
  map: NonNullable<FactoryOverview['settings']> = MAP
): Promise<FactoryPackSettings> {
  return readFactoryPackSettings({
    packKey: 'kit',
    declaration: await declared(),
    map,
    sections: SECTIONS,
    projects,
  });
}

const SECTIONS: NonNullable<FactoryOverview['setting_sections']> = [
  { id: 'held', eyebrow: 'Policies', title: 'What work is held to', kind: 'stage', icon: 'scale' },
];

const projectNamed = (read: FactoryPackSettings, name: string) =>
  read.projects.find(p => p.name === name);

describe('findPackDeclaration', () => {
  test("returns the pack's settings in the declaration's order, with description, default and type", async () => {
    const found = await declared();
    expect(found).toEqual({
      path: join(roots.globalWorkflows, 'kit', '.pack', 'pack.yaml'),
      settings: [
        [
          'zeta_policy',
          {
            type: 'string',
            description: 'Path to the zeta policy. Shadow only for now.',
            default: '',
          },
        ],
        ['alpha_policy', { type: 'string', description: 'Path to the alpha policy.' }],
        ['checks_file', { type: 'string', default: '' }],
        ['command', { type: 'string', default: 'make test' }],
      ],
    });
  });

  test('returns a broken declaration as its error, and null for a pack with none', async () => {
    await declare('inputs:\n  1bad: {}\n');
    const found = await findPackDeclaration(roots, 'kit');
    expect(found !== null && 'error' in found ? found.error : null).toContain("'1bad'");
    expect(await findPackDeclaration(roots, 'other')).toBeNull();
  });
});

describe('readFactoryPackSettings', () => {
  test('lists the settings in order with what the overview map says of them', async () => {
    const result = await read([]);
    expect(
      result.settings.map(s => [s.name, s.shadow, s.pointsTo, s.default, s.section, s.whenLive])
    ).toEqual([
      ['zeta_policy', true, 'policy', '', 'held', 'Would act on it'],
      ['alpha_policy', false, 'policy', null, 'held', null],
      ['checks_file', true, 'checks', '', null, null],
      ['command', false, null, 'make test', null, null],
    ]);
    expect(result.sections).toEqual(SECTIONS);
  });

  test('reads set, empty and unset values, and a missing settings file as all unset', async () => {
    const web = await project(
      'web',
      'settings:\n  zeta_policy: ""\n  command: bun test\n  alpha_policy: 3\n'
    );
    const bare = await project('bare', null);
    const result = await read([web, bare]);
    expect(projectNamed(result, 'web')?.values).toEqual({
      zeta_policy: { state: 'empty' },
      alpha_policy: {
        state: 'set',
        value: '3',
        problem: 'must be a string (quote it in YAML), got 3',
        file: null,
      },
      checks_file: { state: 'unset' },
      command: { state: 'set', value: 'bun test', problem: null, file: null },
    });
    expect(Object.values(projectNamed(result, 'bare')?.values ?? {})).toEqual([
      { state: 'unset' },
      { state: 'unset' },
      { state: 'unset' },
      { state: 'unset' },
    ]);
    expect(projectNamed(result, 'bare')?.error).toBeNull();
  });

  test('lists a key the pack does not declare, as the file has it', async () => {
    const web = await project('web', 'settings:\n  colour: red\n  retries: 2\n');
    expect(projectNamed(await read([web]), 'web')?.undeclared).toEqual([
      { name: 'colour', value: 'red' },
      { name: 'retries', value: '2' },
    ]);
  });

  test('looks up a policy file in the project: found, missing, and outside the project', async () => {
    const web = await project(
      'web',
      'settings:\n  zeta_policy: docs/zeta.md\n  alpha_policy: docs/gone.md\n',
      { 'docs/zeta.md': '# Zeta' }
    );
    const values = projectNamed(await read([web]), 'web')?.values;
    expect(values?.zeta_policy).toEqual({
      state: 'set',
      value: 'docs/zeta.md',
      problem: null,
      file: {
        display: 'docs/zeta.md',
        full: join(web.cwd, 'docs', 'zeta.md'),
        status: 'found',
        error: null,
        checks: null,
      },
    });
    const gone = values?.alpha_policy;
    expect(gone?.state === 'set' ? [gone.file?.display, gone.file?.status] : null).toEqual([
      'docs/gone.md',
      'missing',
    ]);

    const elsewhere = await project(
      'elsewhere',
      'settings:\n  alpha_policy: ../web/docs/zeta.md\n'
    );
    const outside = projectNamed(await read([elsewhere]), 'elsewhere')?.values.alpha_policy;
    expect(outside?.state === 'set' ? [outside.file?.display, outside.file?.status] : null).toEqual(
      [join(web.cwd, 'docs', 'zeta.md'), 'found']
    );
  });

  test('lists the checks of a checks file, and names a file that does not list them', async () => {
    const web = await project('web', 'settings:\n  checks_file: checks.yaml\n', {
      'checks.yaml':
        'checks:\n  - name: lint\n    run: bun run lint\n  - name: test\n    run: bun test\n',
    });
    const bad = await project('bad', 'settings:\n  checks_file: checks.yaml\n', {
      'checks.yaml': 'checks:\n  - name: lint\n',
    });
    const result = await read([web, bad]);
    const listed = projectNamed(result, 'web')?.values.checks_file;
    expect(listed?.state === 'set' ? listed.file?.checks : null).toEqual([
      { name: 'lint', run: 'bun run lint' },
      { name: 'test', run: 'bun test' },
    ]);
    const refused = projectNamed(result, 'bad')?.values.checks_file;
    expect(refused?.state === 'set' ? refused.file : null).toMatchObject({
      display: 'checks.yaml',
      status: 'unreadable',
      checks: null,
    });
    expect(refused?.state === 'set' ? refused.file?.error : null).toContain("'checks.0.run'");
  });

  test('names a map key the pack does not declare', async () => {
    const result = await read([], { ...MAP, retired_policy: { shadow: true } });
    expect(result.mapErrors).toHaveLength(1);
    expect(result.mapErrors[0]).toContain('"retired_policy"');
    expect(result.settings.map(s => s.name)).not.toContain('retired_policy');
  });

  test("reports one project's broken settings file on that project only", async () => {
    const broken = await project('broken', 'settings: [not, a, map]\n');
    const web = await project('web', 'settings:\n  command: bun test\n');
    const result = await read([broken, web]);
    expect(projectNamed(result, 'broken')).toMatchObject({ values: {}, undeclared: [] });
    expect(projectNamed(result, 'broken')?.error).toContain("'settings' must be a mapping");
    expect(projectNamed(result, 'web')?.error).toBeNull();
    expect(projectNamed(result, 'web')?.values.command).toMatchObject({ value: 'bun test' });
  });

  test('a broken declaration is reported, with no settings and no project read', async () => {
    const result = await readFactoryPackSettings({
      packKey: 'kit',
      declaration: { path: '/p/.pack/pack.yaml', error: 'not valid YAML' },
      map: MAP,
      projects: [await project('web', 'settings:\n  colour: red\n')],
    });
    expect(result).toMatchObject({
      declaration: { path: '/p/.pack/pack.yaml', error: 'not valid YAML' },
      sections: [],
      settings: [],
      mapErrors: [],
      projects: [],
    });
  });
});
