// @archon-test-isolated
/**
 * Pack settings at load: a pack's declaration, the project's settings file, and the pack
 * a discovered workflow carries. Every failure names the file and the key.
 */
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readProjectPackSettings,
  packSettingValue,
  parsePackDeclaration,
  PackSettingsError,
} from './pack-settings';
import type { PackSettingSpec } from './schemas/pack-settings';
import { discoverWorkflows } from './workflow-discovery';
import { resolveTopLevelInputs } from './utils/workflow-requirements';
import { WorkflowInputContractError } from './workflow-inputs';

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

beforeEach(async () => {
  cwd = join(tmpdir(), `packdecl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  process.env.ARCHON_HOME = join(cwd, 'home');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

const SPECS: Record<string, PackSettingSpec> = {
  forge: { type: 'enum', values: ['gh', 'glab'] },
  strict: { type: 'bool' },
  reviewers: { type: 'list' },
  label: { type: 'string' },
};

describe('packSettingValue', () => {
  it.each([
    ['forge', 'gh', 'gh'],
    ['strict', true, 'true'],
    ['strict', 'false', 'false'],
    ['reviewers', 'ann, bo', 'ann, bo'],
    ['reviewers', '', ''],
    ['label', 'anything at all', 'anything at all'],
  ])('accepts %s = %p as %p', (name, raw, expected) => {
    expect(packSettingValue(SPECS[name], raw)).toEqual({ value: expected });
  });

  it.each([
    ['forge', 'bitbucket', 'must be one of gh, glab'],
    ['strict', 'yes', 'must be true or false'],
    ['reviewers', 'ann,,bo', 'no empty items'],
    ['label', 3, 'must be a string'],
    ['label', true, 'must be a string'],
  ])('refuses %s = %p', (name, raw, reason) => {
    const result = packSettingValue(SPECS[name], raw);
    expect('error' in result && result.error).toContain(reason);
  });
});

describe('parsePackDeclaration', () => {
  it('reads typed settings and normalizes a YAML boolean default to text', () => {
    expect(
      parsePackDeclaration(
        'inputs:\n  strict:\n    type: bool\n    default: true\n  forge:\n    type: enum\n    values: [gh, glab]\n    required: true\n  note:\n    description: free text\n',
        'p/.pack/pack.yaml'
      )
    ).toEqual({
      strict: { type: 'bool', default: 'true' },
      forge: { type: 'enum', values: ['gh', 'glab'], required: true },
      note: { type: 'string', description: 'free text' },
    });
  });

  it.each([
    ['settings:\n  a: {}\n', "unknown key 'settings'"],
    ['inputs:\n  "bad name": {}\n', "input 'bad name' is not a valid name"],
    ['inputs:\n  forge:\n    type: enum\n', "input 'forge' is invalid"],
    ['inputs:\n  forge:\n    type: string\n    values: [a]\n', "input 'forge' is invalid"],
    ['inputs:\n  strict:\n    type: bool\n    default: maybe\n', "input 'strict' default"],
    ['inputs:\n  x:\n    required: true\n    default: a\n', "input 'x' sets both"],
    ['inputs:\n  foo-bar: {}\n  foo_bar: {}\n', "both map to env var 'INPUTS_FOO_BAR'"],
    ['inputs:\n  __proto__:\n    default: a\n', "'__proto__' cannot be a setting name"],
  ])('refuses %p, naming the file and key', (yaml, reason) => {
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow(PackSettingsError);
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow(reason);
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow('p/.pack/pack.yaml');
  });
});

describe('readProjectPackSettings', () => {
  const pack = { key: 'alpha', source: 'project' as const, settings: SPECS };
  const projectFile = (): string => join(cwd, '.archon', 'packs', 'alpha.yaml');

  async function writeProject(yaml: string): Promise<void> {
    await mkdir(join(cwd, '.archon', 'packs'), { recursive: true });
    await writeFile(projectFile(), yaml);
  }

  it('reads nothing from a missing file', async () => {
    expect(await readProjectPackSettings(cwd, pack)).toEqual({});
  });

  it("returns only the file's values, not declaration defaults", async () => {
    await writeProject('settings:\n  forge: glab\n  strict: false\n');
    const declared = {
      key: 'alpha',
      source: 'project',
      settings: { ...SPECS, label: { type: 'string', default: 'd' } },
    } as const;
    expect(await readProjectPackSettings(cwd, declared)).toEqual({
      forge: 'glab',
      strict: 'false',
    });
  });

  it.each([
    ['settings:\n  colour: red\n', "unknown setting 'colour'"],
    ['settings:\n  strict: maybe\n', "setting 'strict' must be true or false"],
    ['settings:\n  forge: svn\n', "setting 'forge' must be one of gh, glab"],
    ['config:\n  forge: gh\n', "unknown key 'config'"],
  ])('refuses %p, naming the file and key', async (yaml, reason) => {
    await writeProject(yaml);
    const loading = readProjectPackSettings(cwd, pack);
    await expect(loading).rejects.toThrow(reason);
    await expect(readProjectPackSettings(cwd, pack)).rejects.toThrow(projectFile());
  });

  it('refuses any setting for a pack that declares none', async () => {
    await writeProject('settings:\n  forge: gh\n');
    await expect(readProjectPackSettings(cwd, { key: 'alpha', source: 'project' })).rejects.toThrow(
      "pack 'alpha' declares no settings"
    );
  });
});

describe('discovery carries the pack', () => {
  async function writePackWorkflow(pack: string, name: string, yaml: string): Promise<void> {
    const dir = join(cwd, '.archon', 'workflows', pack, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.yaml`), yaml);
  }
  async function writeDeclaration(pack: string, yaml: string): Promise<void> {
    await mkdir(join(cwd, '.archon', 'workflows', pack, '.pack'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'workflows', pack, '.pack', 'pack.yaml'), yaml);
  }
  const discover = () =>
    discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false });

  it('keys a scope pack by its folder and attaches its declaration; a flat workflow has none', async () => {
    await writeDeclaration('alpha', 'inputs:\n  tone:\n    default: calm\n');
    await writePackWorkflow(
      'alpha',
      'packed',
      'name: packed\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    await writeFile(
      join(cwd, '.archon', 'workflows', 'flat.yaml'),
      'name: flat\ndescription: d\npack:\n  key: alpha\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(errors).toEqual([]);
    const byName = new Map(workflows.map(w => [w.workflow.name, w.workflow]));
    expect(byName.get('packed')?.pack).toEqual({
      key: 'alpha',
      source: 'project',
      settings: { tone: { type: 'string', default: 'calm' } },
    });
    // A `pack:` key in YAML cannot claim a pack: only discovery sets it.
    expect(byName.get('flat')?.pack).toBeUndefined();
  });

  it('fails every workflow of a pack whose declaration is invalid, naming the file and key', async () => {
    await writeDeclaration('alpha', 'inputs:\n  strict:\n    type: bool\n    default: maybe\n');
    await writePackWorkflow(
      'alpha',
      'one',
      'name: one\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    await writePackWorkflow(
      'alpha',
      'two',
      'name: two\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(workflows.map(w => w.workflow.name)).toEqual([]);
    expect(errors.map(e => e.filename).sort()).toEqual(['one.yaml', 'two.yaml']);
    for (const error of errors) {
      expect(error.error).toContain('alpha/.pack/pack.yaml');
      expect(error.error).toContain("input 'strict'");
    }
  });

  it('refuses a workflow input that collides with a pack setting on its env key', async () => {
    await writeDeclaration('alpha', 'inputs:\n  foo-bar: {}\n');
    await writePackWorkflow(
      'alpha',
      'clash',
      'name: clash\ndescription: d\ninputs:\n  foo_bar:\n    default: x\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(workflows).toEqual([]);
    expect(errors[0]?.error).toContain("both map to env var 'INPUTS_FOO_BAR'");
  });

  it('lets a bash node of a pack workflow that declares inputs read a pack setting', async () => {
    await writeDeclaration('alpha', 'inputs:\n  tone: {}\n');
    await writePackWorkflow(
      'alpha',
      'reader',
      'name: reader\ndescription: d\ninputs:\n  own:\n    default: x\nnodes:\n  - id: a\n    bash: echo "$INPUTS_OWN $INPUTS_TONE"\n'
    );
    const { workflows, errors } = await discover();
    expect(errors).toEqual([]);
    expect(workflows.map(w => w.workflow.name)).toEqual(['reader']);
  });
});

describe('--input may set a pack setting for one run', () => {
  const workflow = {
    name: 'packed',
    inputs: { own: { default: 'x' } },
    pack: { key: 'alpha', source: 'project' as const, settings: SPECS },
  };

  it('accepts a pack setting of the right type', () => {
    expect(resolveTopLevelInputs(workflow, { forge: 'glab', own: 'y' })).toEqual({
      forge: 'glab',
      own: 'y',
    });
  });

  it('refuses a pack setting of the wrong type', () => {
    expect(() => resolveTopLevelInputs(workflow, { strict: 'yes' })).toThrow(
      "pack setting 'strict' must be true or false"
    );
  });

  it('still refuses a name neither the workflow nor its pack declares, listing both', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs(workflow, { colour: 'red' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowInputContractError);
    expect((thrown as WorkflowInputContractError).undeclared).toEqual(['colour']);
    expect((thrown as Error).message).toContain('Pack settings: forge, label, reviewers, strict.');
  });
});
