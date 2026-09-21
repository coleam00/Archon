import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers';
import type { WorkflowDeps } from './deps';

const root = await mkdtemp(join(tmpdir(), 'archon-live-bundle-'));
let app = join(root, 'app');
const project = join(root, 'project');
const home = join(root, 'home');
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = home;
registerBuiltinProviders();
const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  getDefaultWorkflowsPath: () => join(app, 'workflows', 'defaults'),
  getDefaultCommandsPath: () => join(app, 'commands', 'defaults'),
}));

const inventory = await import('./defaults/bundle-inventory');
const defaults = await import('./defaults/bundled-defaults');
let selectedPacks = ['defaults', 'shipped'];
const index = spyOn(inventory, 'readBundleIndex').mockImplementation(async () => selectedPacks);
const binary = spyOn(defaults, 'isBinaryBuild').mockReturnValue(false);
const { discoverWorkflows } = await import('./workflow-discovery');
const { discoverScriptsForCwd } = await import('./script-discovery');
const { loadCommandPrompt } = await import('./executor-shared');
const { discoverAvailableCommands, validateWorkflowResources } = await import('./validator');
const { captureWorkflowSource, capturedSourceRoots } = await import('./workflow-source');
const { formatPackagedResourceReference } = await import('./packaged-workflow');
const { parseWorkflow } = await import('./loader');

const deps: Pick<WorkflowDeps, 'loadConfig'> = {
  loadConfig: async () => ({
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    commands: {},
  }),
};

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function packagedCommand(pack: string): string {
  return formatPackagedResourceReference({ source: 'bundled', pack, workflow: 'flow' }, 'review');
}

async function pack(directory: string, packName: string, name: string): Promise<void> {
  const path = join(directory, packName, 'flow');
  await write(
    join(path, `${name}.yml`),
    `name: ${name}\ndescription: fixture\nnodes:\n  - id: work\n    command: review\n`
  );
  await write(join(path, 'commands', 'review.md'), `${name} command`);
  await write(join(path, 'scripts', 'helper.ts'), `console.log('${name}')`);
}

await mkdir(join(app, 'workflows', 'defaults'), { recursive: true });
await write(join(app, 'commands', 'defaults', 'flat-command.md'), 'flat command');
await pack(join(app, 'workflows'), 'shipped', 'shipped-flow');
await pack(join(app, 'workflows'), 'excluded', 'excluded-flow');
await pack(join(project, '.archon', 'workflows'), 'project-only', 'project-flow');
await pack(join(home, 'workflows'), 'home-only', 'home-flow');

beforeEach(() => {
  app = join(root, 'app');
  selectedPacks = ['defaults', 'shipped'];
  index.mockImplementation(async () => selectedPacks);
  binary.mockReturnValue(false);
});

afterAll(async () => {
  binary.mockRestore();
  index.mockRestore();
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(root);
});

test('live source catalogs exclude unindexed bundled packs while retaining project and home packs', async () => {
  const result = await discoverWorkflows(project);
  expect(result.errors).toEqual([]);
  expect(result.workflows.map(entry => entry.workflow.name).sort()).toEqual([
    'home-flow',
    'project-flow',
    'shipped-flow',
  ]);
});

test('live script discovery uses the indexed bundle while retaining project and home scripts', async () => {
  const scripts = await discoverScriptsForCwd(project);
  expect([...scripts.keys()].sort()).toEqual([
    '__archon_pack__bundled:shipped:flow::helper',
    '__archon_pack__global:home-only:flow::helper',
    '__archon_pack__project:project-only:flow::helper',
  ]);
});

test('live bundled command execution rejects an unindexed owner', async () => {
  expect(await loadCommandPrompt(deps, project, packagedCommand('shipped'))).toEqual({
    success: true,
    content: 'shipped-flow command',
  });
  expect(await loadCommandPrompt(deps, project, packagedCommand('excluded'))).toMatchObject({
    success: false,
    reason: 'not_found',
  });
});

test('live validation rejects an unindexed bundled command owner', async () => {
  const parsed = parseWorkflow(
    `name: check\ndescription: fixture\nnodes:\n  - id: work\n    command: ${packagedCommand('excluded')}\n`,
    'check.yaml'
  );
  if (!parsed.workflow) throw new Error('Invalid test workflow');
  const issues = await validateWorkflowResources(parsed.workflow, project);
  expect(issues.some(issue => issue.level === 'error' && issue.field === 'command')).toBe(true);
});

test('removing defaults from the index removes flat bundled commands from listing, validation and execution', async () => {
  expect(await discoverAvailableCommands(project)).toContain('flat-command');
  selectedPacks = ['shipped'];
  expect(await discoverAvailableCommands(project)).not.toContain('flat-command');
  expect(await loadCommandPrompt(deps, project, 'flat-command')).toMatchObject({
    success: false,
    reason: 'not_found',
  });
  const parsed = parseWorkflow(
    'name: check\ndescription: fixture\nnodes:\n  - id: work\n    command: flat-command\n',
    'check.yaml'
  );
  if (!parsed.workflow) throw new Error('Invalid test workflow');
  const issues = await validateWorkflowResources(parsed.workflow, project);
  expect(issues.some(issue => issue.level === 'error' && issue.field === 'command')).toBe(true);
});

test('a same-named nested file does not hide a flat bundled default command', async () => {
  // `aaa-group` sorts before `flat-command.md`, so a 1-deep basename-deduped walk hands
  // the name's slot to the nested file and drops the root entry from its results
  // entirely. The flat scope is a direct path lookup, so the root command still resolves.
  const shadow = join(app, 'commands', 'defaults', 'aaa-group');
  const block = join(app, 'workflows', 'defaults', 'shadow-block.yml');
  const parent = join(app, 'workflows', 'defaults', 'shadow-parent.yml');
  await write(join(shadow, 'flat-command.md'), 'nested command');
  await write(
    block,
    'name: shadow-block\ndescription: fixture\nnodes:\n  - id: work\n    command: flat-command\n'
  );
  await write(
    parent,
    'name: shadow-parent\ndescription: fixture\nnodes:\n  - id: block\n    include: shadow-block\n'
  );
  try {
    expect(await discoverAvailableCommands(project)).toContain('flat-command');
    expect(await loadCommandPrompt(deps, project, 'flat-command')).toEqual({
      success: true,
      content: 'flat command',
    });
    const parsed = parseWorkflow(
      'name: check\ndescription: fixture\nnodes:\n  - id: work\n    command: flat-command\n',
      'check.yaml'
    );
    if (!parsed.workflow) throw new Error('Invalid test workflow');
    const issues = await validateWorkflowResources(parsed.workflow, project);
    expect(issues.some(issue => issue.level === 'error' && issue.field === 'command')).toBe(false);
    // The include expander compiles a block's command body through the same scope.
    const result = await discoverWorkflows(project);
    expect(result.errors).toEqual([]);
    expect(result.workflows.some(entry => entry.workflow.name === 'shadow-parent')).toBe(true);
  } finally {
    await removeTempTree(shadow);
    await rm(block);
    await rm(parent);
  }
});

test('a captured bundle retains formerly indexed resources without reading the live index', async () => {
  selectedPacks = ['defaults', 'shipped', 'excluded'];
  const capture = await captureWorkflowSource({
    sourceRoot: project,
    captureRoot: join(root, 'capture'),
  });
  const roots = capturedSourceRoots(capture.anchor);
  index.mockImplementation(async () => {
    throw new Error('Captured consumers must not read the live index');
  });
  const result = await discoverWorkflows(project, { sourceRoots: roots });
  expect(result.errors).toEqual([]);
  expect(result.workflows.map(entry => entry.workflow.name)).toContain('excluded-flow');
  expect(
    (await discoverScriptsForCwd(project, roots)).has(
      '__archon_pack__bundled:excluded:flow::helper'
    )
  ).toBe(true);
  expect(
    await loadCommandPrompt(deps, project, packagedCommand('excluded'), undefined, roots)
  ).toEqual({
    success: true,
    content: 'excluded-flow command',
  });
  expect(await loadCommandPrompt(deps, project, 'flat-command', undefined, roots)).toEqual({
    success: true,
    content: 'flat command',
  });
});

test('live indexed workflow and script additions are visible without regenerating the binary bundle', async () => {
  const yamlPath = join(app, 'workflows', 'shipped', 'flow', 'shipped-flow.yml');
  const addedWorkflow = join(app, 'workflows', 'shipped', 'late-workflow');
  const original = await readFile(yamlPath, 'utf8');
  try {
    await write(yamlPath, original.replace('description: fixture', 'description: edited live'));
    await write(
      join(addedWorkflow, 'late-workflow.yaml'),
      'name: late-workflow\ndescription: added live\nnodes:\n  - id: work\n    prompt: work\n'
    );
    await write(
      join(app, 'workflows', 'shipped', 'flow', 'scripts', 'late.ts'),
      'console.log("late")'
    );
    const result = await discoverWorkflows(project);
    expect(
      result.workflows.find(entry => entry.workflow.name === 'shipped-flow')?.workflow.description
    ).toBe('edited live');
    expect(result.workflows.some(entry => entry.workflow.name === 'late-workflow')).toBe(true);
    expect(
      (await discoverScriptsForCwd(project)).has('__archon_pack__bundled:shipped:flow::late')
    ).toBe(true);
  } finally {
    await write(yamlPath, original);
    await removeTempTree(addedWorkflow);
  }
});

test('binary discovery preserves an authored yml filename when a project overrides it', async () => {
  const name = 'selection-yml-override';
  const yaml = `name: ${name}\ndescription: bundled version\nnodes:\n  - id: work\n    prompt: work\n`;
  const paths = defaults.BUNDLED_WORKFLOW_PATHS;
  expect(Object.hasOwn(defaults.BUNDLED_WORKFLOWS, name)).toBe(false);
  Object.assign(defaults.BUNDLED_WORKFLOWS, { [name]: yaml });
  Object.assign(paths, { [name]: `workflows/defaults/${name}.yml` });
  await write(
    join(project, '.archon', 'workflows', `${name}.yml`),
    yaml.replace('bundled version', 'project version')
  );
  binary.mockReturnValue(true);
  index.mockImplementation(async () => {
    throw new Error('A binary must not read the source index');
  });
  try {
    const result = await discoverWorkflows(project);
    expect(result.errors).toEqual([]);
    const matches = result.workflows.filter(entry => entry.workflow.name === name);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.workflow.description).toBe('project version');
    const command = Object.entries(defaults.BUNDLED_COMMANDS).find(
      ([key]) => !key.startsWith('__archon_pack__')
    );
    if (!command) throw new Error('The binary fixture needs a bundled flat command');
    expect(await discoverAvailableCommands(project)).toContain(command[0]);
    expect(await loadCommandPrompt(deps, project, command[0])).toEqual({
      success: true,
      content: command[1],
    });
  } finally {
    Reflect.deleteProperty(defaults.BUNDLED_WORKFLOWS, name);
    Reflect.deleteProperty(paths, name);
  }
});

test('SDK discovery without an installed source tree retains project and home resources', async () => {
  app = join(root, 'absent-app');
  const result = await discoverWorkflows(project);
  expect(result.errors).toEqual([]);
  expect(result.workflows.some(entry => entry.source === 'bundled')).toBe(false);
  const scripts = await discoverScriptsForCwd(project);
  expect([...scripts.keys()].some(name => name.startsWith('__archon_pack__bundled:'))).toBe(false);
  expect(scripts.has('__archon_pack__project:project-only:flow::helper')).toBe(true);
});

test('a partial source installation fails instead of appearing to have no bundled resources', async () => {
  app = join(root, 'partial-app');
  await write(join(app, 'commands', 'defaults', 'flat-command.md'), 'partial command');
  const result = await discoverWorkflows(project);
  expect(result.errors.some(error => error.error.includes('Indexed bundle pack'))).toBe(true);
  await expect(discoverScriptsForCwd(project)).rejects.toThrow('Indexed bundle pack');
});

test('a missing index in an installed source tree remains a visible discovery error', async () => {
  index.mockImplementation(async () => {
    throw Object.assign(new Error('Missing installed bundle index'), { code: 'ENOENT' });
  });
  const result = await discoverWorkflows(project);
  expect(result.errors.some(error => error.error === 'Missing installed bundle index')).toBe(true);
});

test('an existing non-directory bundle root is an invalid installation', async () => {
  app = join(root, 'invalid-app');
  await write(join(app, 'workflows'), 'not a directory');
  const result = await discoverWorkflows(project);
  expect(result.errors).toHaveLength(1);
  await expect(discoverScriptsForCwd(project)).rejects.toThrow();
});
