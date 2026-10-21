// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import {
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
  mock,
  type Mock,
} from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';

const isWindows = process.platform === 'win32';

// Inline mock logger to suppress noisy output during tests
type MockLog = (data: unknown, message?: string, ...args: unknown[]) => undefined;
const mockLogger = {
  fatal: mock<MockLog>(() => undefined),
  error: mock<MockLog>(() => undefined),
  warn: mock<MockLog>(() => undefined),
  info: mock<MockLog>(() => undefined),
  debug: mock<MockLog>(() => undefined),
  trace: mock<MockLog>(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

// A fake bundled pack stands in for the shipped one: source mode reads its tree through
// `getBundledWorkflowsPath`, binary mode the records built from it.
const bundleRoot = await mkdtemp(join(tmpdir(), 'loader-bundle-'));
afterAll(() => removeTempTree(bundleRoot));
const fakeBundle = await writeFakeBundle(
  bundleRoot,
  {
    'fake/review/fake-review.yaml':
      'name: fake-review\ndescription: Bundled review\nnodes:\n  - id: check\n    command: check\n',
    'fake/review/commands/check.md': 'Check the change against its contract.\n',
  },
  ['fake']
);
const realBundledDefaults = await import('./defaults/bundled-defaults');
mock.module('./defaults/bundled-defaults', () => ({ ...realBundledDefaults, ...fakeBundle }));
spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue(['fake']);

// Mock @archon/paths: suppress logger + pass through real path utilities
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
  getBundledWorkflowsPath: () => bundleRoot,
}));

// Bootstrap provider registry (needed by isRegisteredProvider checks at load time)
import { clearRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
clearRegistry();
registerBuiltinProviders();

import {
  discoverWorkflows as discoverWorkflowsWithProviders,
  discoverWorkflowsWithConfig,
} from './workflow-discovery';
import { isAgentNode, isIncludeDirective, isLoopGroupNode } from './schemas';
import type { DagNode, IncludeDirective } from './schemas';
import { readHomeMcpDirectory } from './compiled-command';
import * as bundledDefaults from './defaults/bundled-defaults';
import * as bundleInventory from './defaults/bundle-inventory';
import { writeFakeBundle } from './test-fake-bundle';
import { parsePackagedResourceReference } from './packaged-workflow';
import { discoverScriptsForCwd } from './script-discovery';
import { validateWorkflowResources } from './validator';
import { mapNodeTemplateSlots, mapNodeTemplateValueSlots } from './template-walker';

function discoverWorkflows(
  cwd: string | null,
  options: Omit<Parameters<typeof discoverWorkflowsWithProviders>[1], 'providers'> = {}
) {
  return discoverWorkflowsWithProviders(cwd, { ...options, providers: providerRegistry });
}

/** The inline prompt text of an agent node, or undefined for any other kind
 * (formerly the bare `'prompt' in node ? node.prompt : ...` idiom, #2486). */
function inlinePrompt(node: DagNode | IncludeDirective | undefined): string | undefined {
  return node && !isIncludeDirective(node) && isAgentNode(node) && node.source.kind === 'inline'
    ? node.source.prompt
    : undefined;
}

/**
 * Write one workflow YAML into `<root>/.archon/workflows/`, creating the folder.
 *
 * This is the file's dominant setup — nearly every test needs one workflow on
 * disk — and open-coding the mkdir/join/writeFile made the setup longer than the
 * assertion it served (#3169). Tests that need a tree this cannot express (an
 * empty workflows folder, a nested pack, a broken symlink, a non-YAML sibling)
 * still write it by hand; do not grow this an option at a time.
 */
async function writeWorkflowFile(root: string, filename: string, yaml: string): Promise<void> {
  const dir = join(root, '.archon', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), yaml);
}

describe('workflow discovery', () => {
  let testDir: string;
  const originalArchonHome = process.env.ARCHON_HOME;
  const originalArchonDocker = process.env.ARCHON_DOCKER;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    process.env.ARCHON_HOME = join(testDir, 'home');
    delete process.env.ARCHON_DOCKER;
  });

  afterEach(async () => {
    await removeTempTree(testDir);
    if (originalArchonHome === undefined) {
      delete process.env.ARCHON_HOME;
    } else {
      process.env.ARCHON_HOME = originalArchonHome;
    }
    if (originalArchonDocker === undefined) {
      delete process.env.ARCHON_DOCKER;
    } else {
      process.env.ARCHON_DOCKER = originalArchonDocker;
    }
  });

  describe('MCP declaration provenance', () => {
    it.each(['', 'nested', 'pack/flow'])(
      'keeps the actual home YAML directory: %s',
      async subdir => {
        const yamlDir = join(testDir, 'home', 'workflows', subdir);
        await mkdir(yamlDir, { recursive: true });
        await writeFile(
          join(yamlDir, 'home.yaml'),
          `name: portable
description: Home MCP
nodes:
  - id: check
    prompt: Check
    mcp: servers.json
`
        );
        await writeFile(join(yamlDir, 'servers.json'), '{"home":{"command":"example"}}');
        const catalog = await discoverWorkflows(testDir, { loadDefaults: false });
        expect(catalog.errors).toEqual([]);
        const entry = catalog.workflows.find(e => e.source === 'global');
        if (!entry) throw new Error('Missing home workflow');
        expect(readHomeMcpDirectory(entry.workflow.nodes[0])).toBe(yamlDir);
        expect(
          (await validateWorkflowResources(entry.workflow, testDir, providerRegistry)).filter(
            i => i.field === 'mcp'
          )
        ).toEqual([]);
      }
    );

    it('preserves declaration ownership across mixed scopes, nested includes and loop bodies', async () => {
      const homeDir = join(testDir, 'home', 'workflows', 'nested');
      const projectDir = join(testDir, '.archon', 'workflows');
      await mkdir(homeDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(homeDir, 'home.yaml'),
        `name: home-block
description: Home declaration
nodes:
  - id: group
    loop_group:
      until: done
      max_iterations: 1
      nodes:
        - id: check
          prompt: Check
          mcp: servers.json
`
      );
      await writeFile(
        join(projectDir, 'project.yaml'),
        `name: project-block
description: Project declaration
nodes:
  - id: check
    prompt: Check
    mcp: servers.json
`
      );
      await writeFile(
        join(testDir, 'home', 'workflows', 'middle.yaml'),
        `name: middle
description: Mixed includes
nodes:
  - id: home
    include: home-block
  - id: project
    include: project-block
`
      );
      await writeFile(
        join(projectDir, 'parent.yaml'),
        `name: parent
description: Second level
nodes:
  - id: outer
    include: middle
`
      );
      await writeFile(join(homeDir, 'servers.json'), '{"home":{}}');
      const catalog = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(catalog.errors).toEqual([]);
      const parent = catalog.workflows.find(e => e.workflow.name === 'parent')?.workflow;
      if (!parent) throw new Error('Missing parent');
      const group = parent.nodes.find(n => n.id === 'outer__home__group');
      const project = parent.nodes.find(n => n.id === 'outer__project__check');
      if (!group || isIncludeDirective(group) || !isLoopGroupNode(group) || !project)
        throw new Error('Missing composed nodes');
      expect(readHomeMcpDirectory(project)).toBeUndefined();
      expect(readHomeMcpDirectory(group.loop_group.nodes[0])).toBe(homeDir);
      for (const clone of [
        mapNodeTemplateSlots(group, slot => slot.value),
        mapNodeTemplateValueSlots(group, slot => slot.value),
      ]) {
        if (!isLoopGroupNode(clone)) throw new Error('Lost group');
        expect(readHomeMcpDirectory(clone.loop_group.nodes[0])).toBe(homeDir);
      }
      const issues = (await validateWorkflowResources(parent, testDir, providerRegistry)).filter(
        i => i.field === 'mcp'
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].nodeId).toBe('outer__project__check');
      expect(issues[0].message).toContain(join(testDir, 'servers.json'));
      expect(issues[0].message).not.toContain(homeDir);
    });
  });

  describe('packaged workflow folders (#2527)', () => {
    it('discovers arbitrary repo pack/workflow folders and qualifies local resources', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows', 'team-kit', 'ship-it');
      await mkdir(join(workflowDir, 'scripts'), { recursive: true });
      await writeFile(join(workflowDir, 'scripts', 'publish.ts'), 'console.log(1);');
      await writeFile(
        join(workflowDir, 'release.yaml'),
        `name: release\ndescription: release\nnodes:\n  - id: command\n    command: prepare\n  - id: script\n    script: publish\n    runtime: bun\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const workflow = result.workflows.find(entry => entry.workflow.name === 'release')?.workflow;
      expect(workflow).toBeDefined();
      const command = parsePackagedResourceReference(
        (workflow?.nodes[0] as { source: { name: string } }).source.name
      );
      const script = parsePackagedResourceReference(
        (workflow?.nodes[1] as { script: string }).script
      );
      expect(command).toEqual({
        owner: { source: 'project', pack: 'team-kit', workflow: 'ship-it' },
        name: 'prepare',
      });
      expect(script).toEqual({
        owner: { source: 'project', pack: 'team-kit', workflow: 'ship-it' },
        name: 'publish',
      });
    });

    it("a composed block's named script still resolves to its OWN pack after composition", async () => {
      // The packaged-ownership claim at the boundary that matters: the script name a
      // composed node carries has to resolve to the file in the BLOCK's pack, not to a
      // same-named script in the parent's. Composition into a different pack is the case
      // (#1764 Task 11 / #2528) — a bare basename would silently pick the wrong program.
      const parentDir = join(testDir, '.archon', 'workflows', 'product', 'parent');
      const blockDir = join(testDir, '.archon', 'workflows', 'shared', 'report-block');
      await mkdir(join(parentDir, 'scripts'), { recursive: true });
      await mkdir(join(blockDir, 'scripts'), { recursive: true });
      await writeFile(
        join(parentDir, 'parent.yaml'),
        `name: script-parent\ndescription: parent\nnodes:\n  - id: rep\n    include: report-block\n`
      );
      await writeFile(
        join(blockDir, 'block.yaml'),
        `name: report-block\ndescription: block\nnodes:\n  - id: run\n    script: report\n    runtime: bun\n`
      );
      // Same basename in both packs — only the qualified reference tells them apart.
      await writeFile(join(parentDir, 'scripts', 'report.ts'), 'console.log("parent");\n');
      await writeFile(join(blockDir, 'scripts', 'report.ts'), 'console.log("block");\n');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const parent = result.workflows.find(w => w.workflow.name === 'script-parent')?.workflow;
      const composed = parent?.nodes.find(n => n.id === 'rep__run') as { script: string };
      expect(parsePackagedResourceReference(composed.script)).toEqual({
        owner: { source: 'project', pack: 'shared', workflow: 'report-block' },
        name: 'report',
      });

      // And that reference is a live key in the map the executor looks the script up in.
      // Stored paths go through `normalizeSep()` (script-discovery.ts), so they are
      // forward-slash on every OS while `join` is backslash on Windows — normalize the
      // expected side, matching the `norm` helper in script-discovery.test.ts.
      const scripts = await discoverScriptsForCwd(testDir);
      expect(scripts.get(composed.script)?.path).toBe(
        join(blockDir, 'scripts', 'report.ts').replaceAll('\\', '/')
      );
    });

    it('resolves an included workflow command from its own package before compiling it', async () => {
      const parentDir = join(testDir, '.archon', 'workflows', 'product', 'parent');
      const blockDir = join(testDir, '.archon', 'workflows', 'shared', 'review-block');
      const blockCommandsDir = join(blockDir, 'commands');
      await mkdir(parentDir, { recursive: true });
      await mkdir(blockCommandsDir, { recursive: true });
      await writeFile(
        join(parentDir, 'parent.yaml'),
        `name: parent\ndescription: parent\nnodes:\n  - id: review\n    include: review-block\n`
      );
      await writeFile(
        join(blockDir, 'block.yaml'),
        `name: review-block\ndescription: block\nnodes:\n  - id: run\n    command: inspect\n`
      );
      await writeFile(join(blockCommandsDir, 'inspect.md'), 'Package-owned review prompt.');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const parent = result.workflows.find(entry => entry.workflow.name === 'parent')?.workflow;
      const included = parent?.nodes.find(node => node.id === 'review__run');
      expect(inlinePrompt(included) ?? '').toBe('Package-owned review prompt.');
    });

    it('rejects a shared module used as a named script while loading the workflow', async () => {
      const pack = join(testDir, '.archon', 'workflows', 'module-pack');
      await mkdir(join(pack, '.shared'), { recursive: true });
      await mkdir(join(pack, 'release'), { recursive: true });
      await writeFile(join(pack, '.shared', 'helper.ts'), 'export const value = 1;');
      await writeFile(
        join(pack, 'release', 'release.yaml'),
        'name: release\ndescription: release\nnodes:\n  - id: run\n    script: helper\n    runtime: bun\n'
      );
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toEqual([
        expect.objectContaining({
          errorType: 'validation_error',
          error: expect.stringContaining('Named packaged script'),
        }),
      ]);
    });

    it('reserves pack .shared folders for modules without workflow discovery errors', async () => {
      const pack = join(testDir, '.archon', 'workflows', 'module-pack');
      await mkdir(join(pack, '.shared'), { recursive: true });
      await mkdir(join(pack, 'release'), { recursive: true });
      await writeFile(join(pack, '.shared', 'value.ts'), 'export const value = 1;');
      await writeFile(
        join(pack, 'release', 'release.yaml'),
        'name: release\ndescription: release\nnodes:\n  - id: run\n    bash: echo ok\n'
      );
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      expect(result.workflows.map(entry => entry.workflow.name)).toContain('release');
    });

    it('uses the identical authored structure in home scope', async () => {
      const homeDir = join(testDir, 'home', 'workflows', 'personal-pack', 'daily');
      await mkdir(homeDir, { recursive: true });
      await writeFile(
        join(homeDir, 'daily.yaml'),
        `name: daily\ndescription: daily\nnodes:\n  - id: run\n    command: summarize\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflow = result.workflows.find(entry => entry.workflow.name === 'daily');
      expect(workflow?.source).toBe('global');
      expect(
        parsePackagedResourceReference(
          (workflow?.workflow.nodes[0] as { source: { name: string } }).source.name
        )
      ).toEqual({
        owner: { source: 'global', pack: 'personal-pack', workflow: 'daily' },
        name: 'summarize',
      });
    });

    it('reports same-scope packaged workflow filename collisions', async () => {
      for (const [pack, workflow, name] of [
        ['one', 'first', 'first'],
        ['two', 'second', 'second'],
      ] as const) {
        const dir = join(testDir, '.archon', 'workflows', pack, workflow);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'same.yaml'),
          `name: ${name}\ndescription: collision\nnodes:\n  - id: run\n    prompt: hi\n`
        );
      }

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.some(entry => entry.workflow.name === 'first')).toBe(false);
      expect(result.workflows.some(entry => entry.workflow.name === 'second')).toBe(false);
      expect(result.errors.some(error => error.error.includes('filename collision'))).toBe(true);
    });

    it('reports a filename collision between flat and packaged workflows', async () => {
      const workflowsRoot = join(testDir, '.archon', 'workflows');
      const packageDir = join(workflowsRoot, 'one', 'first');
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(workflowsRoot, 'same.yaml'),
        'name: flat\ndescription: flat\nnodes:\n  - id: run\n    prompt: hi\n'
      );
      await writeFile(
        join(packageDir, 'same.yaml'),
        'name: packaged\ndescription: packaged\nnodes:\n  - id: run\n    prompt: hi\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.some(entry => entry.workflow.name === 'flat')).toBe(false);
      expect(result.workflows.some(entry => entry.workflow.name === 'packaged')).toBe(false);
      expect(result.errors.some(error => error.error.includes('collision within one scope'))).toBe(
        true
      );
    });

    it('repo filename override selects the repo packaged resource owner', async () => {
      const homeDir = join(testDir, 'home', 'workflows', 'home-pack', 'flow');
      const repoDir = join(testDir, '.archon', 'workflows', 'repo-pack', 'flow');
      await mkdir(homeDir, { recursive: true });
      await mkdir(repoDir, { recursive: true });
      await writeFile(
        join(homeDir, 'same.yaml'),
        `name: home-version\ndescription: home\nnodes:\n  - id: run\n    command: shared\n`
      );
      await writeFile(
        join(repoDir, 'same.yaml'),
        `name: repo-version\ndescription: repo\nnodes:\n  - id: run\n    command: shared\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.some(entry => entry.workflow.name === 'home-version')).toBe(false);
      const repo = result.workflows.find(entry => entry.workflow.name === 'repo-version');
      expect(repo?.source).toBe('project');
      expect(
        parsePackagedResourceReference(
          (repo?.workflow.nodes[0] as { source: { name: string } }).source.name
        )
      ).toEqual({
        owner: { source: 'project', pack: 'repo-pack', workflow: 'flow' },
        name: 'shared',
      });
    });
  });

  describe('fixtures are not workflows (#3183)', () => {
    const fixtureYaml = (id: string): string =>
      `fixture:\n  expect: completed\n  reached: [${id}]\n${id}: {}\n`;

    const writeWorkflowWithFixtures = async (
      segments: readonly string[],
      fixtureNames: readonly string[]
    ): Promise<void> => {
      const dir = join(testDir, '.archon', 'workflows', ...segments);
      await mkdir(join(dir, 'fixtures'), { recursive: true });
      await writeFile(
        join(dir, 'flow.yaml'),
        'name: flow\ndescription: flow\nnodes:\n  - id: run\n    bash: echo hi\n'
      );
      for (const name of fixtureNames) {
        await writeFile(join(dir, 'fixtures', `${name}.stubs.yaml`), fixtureYaml('run'));
      }
    };

    for (const [label, segments] of [
      ['directly under the workflows root', ['flow']],
      ['inside a pack', ['team', 'flow']],
    ] as const) {
      for (const [count, fixtureNames] of [
        ['one fixture', ['greets']],
        ['several fixtures', ['greets', 'partings']],
      ] as const) {
        it(`ignores ${count} ${label}`, async () => {
          await writeWorkflowWithFixtures(segments, fixtureNames);
          const result = await discoverWorkflows(testDir, { loadDefaults: false });
          expect(result.errors).toEqual([]);
          expect(result.workflows.map(entry => entry.workflow.name)).toEqual(['flow']);
        });
      }
    }

    it('ignores a fixtures directory at the workflows root', async () => {
      await mkdir(join(testDir, '.archon', 'workflows', 'fixtures', 'nested'), {
        recursive: true,
      });
      await writeFile(
        join(testDir, '.archon', 'workflows', 'fixtures', 'stray.stubs.yaml'),
        fixtureYaml('run')
      );
      // A subdirectory holds no workflow either: the whole `fixtures/` tree is reserved.
      await writeFile(
        join(testDir, '.archon', 'workflows', 'fixtures', 'nested', 'flow.yaml'),
        'name: buried\ndescription: buried\nnodes:\n  - id: run\n    bash: echo hi\n'
      );
      await writeWorkflowFile(
        testDir,
        'plain.yaml',
        'name: plain\ndescription: plain\nnodes:\n  - id: run\n    bash: echo hi\n'
      );
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      expect(result.workflows.map(entry => entry.workflow.name)).toEqual(['plain']);
    });

    it('still reports a genuinely malformed workflow', async () => {
      await writeWorkflowFile(testDir, 'broken.yaml', 'description: no name\nnodes: []\n');
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("Missing required field 'name'");
    });

    it('still reports a genuinely malformed workflow inside a pack', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows', 'team', 'flow');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(join(workflowDir, 'flow.yaml'), 'description: no name\nnodes: []\n');
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("Missing required field 'name'");
      expect(result.workflows).toEqual([]);
    });

    it('still reports a packaged workflow folder that does not hold exactly one YAML file', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows', 'team', 'flow');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(join(workflowDir, 'one.yaml'), 'name: one\ndescription: one\nnodes: []\n');
      await writeFile(join(workflowDir, 'two.yaml'), 'name: two\ndescription: two\nnodes: []\n');
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('must contain exactly one .yaml or .yml file');
      expect(result.workflows).toEqual([]);
    });
  });

  describe('discoverWorkflows', () => {
    it('should discover workflows from .archon/workflows/', async () => {
      const validYaml = `name: discovered
description: Discovered workflow
nodes:
  - id: test
    command: test
`;
      await writeWorkflowFile(testDir, 'workflow.yaml', validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('discovered');
    });

    it('should load both .yaml and .yml files', async () => {
      const yaml1 = `name: workflow-one
description: First workflow
nodes:
  - id: one
    command: one
`;
      const yaml2 = `name: workflow-two
description: Second workflow
nodes:
  - id: two
    command: two
`;
      await writeWorkflowFile(testDir, 'one.yaml', yaml1);
      await writeWorkflowFile(testDir, 'two.yml', yaml2);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(2);
    });

    it('should recursively load workflows from subdirectories (like defaults/)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const defaultsDir = join(workflowDir, 'defaults');
      await mkdir(defaultsDir, { recursive: true });

      // Workflow in root
      const rootWorkflow = `name: root-workflow
description: Root level workflow
nodes:
  - id: root
    command: root
`;
      // Workflow in subdirectory
      const subWorkflow = `name: sub-workflow
description: Subdirectory workflow
nodes:
  - id: sub
    command: sub
`;
      await writeFile(join(workflowDir, 'root.yaml'), rootWorkflow);
      await writeFile(join(defaultsDir, 'sub.yaml'), subWorkflow);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(2);
      const names = workflows.map(w => w.name).sort();
      expect(names).toEqual(['root-workflow', 'sub-workflow']);
    });

    it('should ignore non-yaml files in workflows directory', async () => {
      // Create a valid yaml and some non-yaml files
      const validYaml = `name: valid-workflow
description: Valid workflow
nodes:
  - id: test
    command: test
`;
      await writeWorkflowFile(testDir, 'valid.yaml', validYaml);
      await writeWorkflowFile(testDir, 'readme.md', '# Readme');
      await writeWorkflowFile(testDir, 'config.json', '{}');
      await writeWorkflowFile(testDir, '.gitkeep', '');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('valid-workflow');
    });

    it('should handle empty workflow directory', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // Directory exists but is empty

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });
  });

  describe('multi-source loading', () => {
    it('should load app defaults when enabled', async () => {
      // Test dir has no .archon/workflows/
      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows.map(w => w.name)).toEqual(['fake-review']);
    });

    it('should override app defaults with repo workflows of same filename', async () => {
      // Create repo workflow with same filename as an app default
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-custom-assist
description: My custom assist (overrides fake-review)
nodes:
  - id: custom
    command: custom-command
`;
      // Use exact same filename as app default to override
      await writeFile(join(repoWorkflowDir, 'fake-review.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should have the repo version, not the app default
      const assistWorkflow = workflows.find(
        w => w.name === 'my-custom-assist' || w.name === 'fake-review'
      );
      expect(assistWorkflow).toBeDefined();
      // Repo version should win (has custom name)
      expect(assistWorkflow?.name).toBe('my-custom-assist');
      expect(assistWorkflow?.description).toBe('My custom assist (overrides fake-review)');
    });

    it('should skip app defaults when loadDefaults is false', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should NOT find the bundled workflow since app defaults are disabled
      expect(workflows.find(w => w.name === 'fake-review')).toBeUndefined();
    });

    it('should combine app defaults with repo workflows', async () => {
      // Create repo workflow with unique name (no collision)
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-custom-workflow
description: My custom workflow
nodes:
  - id: custom
    command: custom-command
`;
      await writeFile(join(repoWorkflowDir, 'my-custom.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should have both app defaults and repo workflows
      const bundledReview = workflows.find(w => w.name === 'fake-review');
      const customWorkflow = workflows.find(w => w.name === 'my-custom-workflow');
      expect(bundledReview).toBeDefined();
      expect(customWorkflow).toBeDefined();
    });
  });

  describe('binary build bundled workflows', () => {
    let isBinaryBuildSpy: Mock<typeof bundledDefaults.isBinaryBuild>;

    beforeEach(() => {
      isBinaryBuildSpy = spyOn(bundledDefaults, 'isBinaryBuild');
    });

    afterEach(() => {
      isBinaryBuildSpy.mockRestore();
    });

    it('should load bundled workflows when running as binary', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows.map(w => w.name)).toEqual(['fake-review']);
    });

    it('should allow repo workflows to override bundled defaults', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Create repo workflow with same filename as bundled default
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: custom-assist-override
description: Custom override of fake-review
nodes:
  - id: custom
    command: custom
`;
      await writeFile(join(repoWorkflowDir, 'fake-review.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Repo workflow should override bundled default
      const assistWorkflow = workflows.find(
        w => w.name === 'custom-assist-override' || w.name === 'fake-review'
      );
      expect(assistWorkflow).toBeDefined();
      expect(assistWorkflow?.name).toBe('custom-assist-override');
    });

    it('should combine bundled workflows with repo workflows', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Create repo workflow with unique name
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-repo-workflow
description: A repo-specific workflow
nodes:
  - id: custom
    command: custom
`;
      await writeFile(join(repoWorkflowDir, 'my-repo.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should have both bundled and repo workflows
      const bundledReview = workflows.find(w => w.name === 'fake-review');
      const repoWorkflow = workflows.find(w => w.name === 'my-repo-workflow');
      expect(bundledReview).toBeDefined();
      expect(repoWorkflow).toBeDefined();
    });
  });

  describe('home-scoped workflows (~/.archon/workflows/)', () => {
    // Home-scope is read unconditionally by discovery — no caller option. Tests
    // redirect `getArchonHome()` to a temp dir via the `ARCHON_HOME` env var so
    // they don't touch the user's real `~/.archon/`.
    let homeDir: string;
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    beforeEach(async () => {
      homeDir = join(tmpdir(), `home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(homeDir, { recursive: true });
      process.env.ARCHON_HOME = homeDir;
      delete process.env.ARCHON_DOCKER;
    });

    afterEach(async () => {
      await removeTempTree(homeDir);
      if (originalArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalArchonHome;
      }
      if (originalArchonDocker === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalArchonDocker;
      }
    });

    it('loads home-scoped workflows from ~/.archon/workflows/ and merges with repo', async () => {
      const homeWorkflowDir = join(homeDir, 'workflows');
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await mkdir(repoWorkflowDir, { recursive: true });

      await writeFile(
        join(homeWorkflowDir, 'home-wf.yaml'),
        'name: home-workflow\ndescription: From home\nnodes:\n  - id: foo\n    command: foo\n'
      );
      await writeFile(
        join(repoWorkflowDir, 'repo-wf.yaml'),
        'name: repo-workflow\ndescription: From repo\nnodes:\n  - id: bar\n    command: bar\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const names = result.workflows.map(w => w.workflow.name);
      expect(names).toContain('home-workflow');
      expect(names).toContain('repo-workflow');
    });

    it('ignores workflows in the retired nested home directory', async () => {
      await writeWorkflowFile(
        homeDir,
        'retired-home.yaml',
        'name: retired-home\ndescription: Only in the retired home path\nnodes:\n  - id: check\n    prompt: Check the change\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.errors).toEqual([]);
      expect(result.workflows).toEqual([]);
    });

    it("classifies home-scoped workflows as source: 'global'", async () => {
      const homeWorkflowDir = join(homeDir, 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await writeFile(
        join(homeWorkflowDir, 'only-home.yaml'),
        'name: only-home\ndescription: From home\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const entry = result.workflows.find(w => w.workflow.name === 'only-home');
      expect(entry?.source).toBe('global');
    });

    it('repo workflow overrides home workflow with the same filename', async () => {
      const homeWorkflowDir = join(homeDir, 'workflows');
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await mkdir(repoWorkflowDir, { recursive: true });

      await writeFile(
        join(homeWorkflowDir, 'shared.yaml'),
        'name: home-version\ndescription: Home version\nnodes:\n  - id: h\n    command: c\n'
      );
      await writeFile(
        join(repoWorkflowDir, 'shared.yaml'),
        'name: repo-version\ndescription: Repo override\nnodes:\n  - id: r\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const shared = result.workflows.find(
        w => w.workflow.name === 'home-version' || w.workflow.name === 'repo-version'
      );
      expect(shared?.workflow.name).toBe('repo-version');
      expect(shared?.source).toBe('project');
    });

    it('supports 1-level subfolders under ~/.archon/workflows/ (e.g. triage/foo.yaml)', async () => {
      const homeWorkflowDir = join(homeDir, 'workflows', 'triage');
      await mkdir(homeWorkflowDir, { recursive: true });
      await writeFile(
        join(homeWorkflowDir, 'grouped.yaml'),
        'name: grouped-workflow\ndescription: In a subfolder\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const entry = result.workflows.find(w => w.workflow.name === 'grouped-workflow');
      expect(entry).toBeDefined();
      expect(entry?.source).toBe('global');
    });

    it('does NOT descend past the fixed pack/workflow boundary', async () => {
      const nestedDir = join(homeDir, 'workflows', 'a', 'b', 'c');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(
        join(nestedDir, 'too-deep.yaml'),
        'name: too-deep\ndescription: Nested too deep\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const entry = result.workflows.find(w => w.workflow.name === 'too-deep');
      expect(entry).toBeUndefined();
    });
  });

  describe('discoverWorkflowsWithConfig', () => {
    it("treats config.yaml's env: as supplied, suppressing the unbound-env-read warning", async () => {
      const scriptsDir = join(testDir, '.archon', 'scripts');
      const workflowsDir = join(testDir, '.archon', 'workflows');
      await mkdir(scriptsDir, { recursive: true });
      await mkdir(workflowsDir, { recursive: true });
      await writeFile(join(scriptsDir, 'verify.ts'), 'console.log(process.env.NAME)\n');
      await writeFile(
        join(workflowsDir, 'uses-configured-env.yaml'),
        `name: uses-configured-env
description: Reads a variable supplied by config.yaml's env section
inputs:
  declared: {}
nodes:
  - id: verify
    script: verify
    runtime: bun
`
      );
      const mockLoadConfig = mock(async () => ({
        envVars: { NAME: 'value' },
      }));

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig, providerRegistry);

      expect(result.errors).toEqual([]);
      const entry = result.workflows.find(w => w.workflow.name === 'uses-configured-env');
      expect(entry).toBeDefined();
      expect(entry?.parseWarnings ?? []).toEqual([]);
    });

    it("still treats config.yaml's env: as supplied once discovery runs from a frozen capture", async () => {
      const scriptsDir = join(testDir, '.archon', 'scripts');
      const workflowsDir = join(testDir, '.archon', 'workflows');
      await mkdir(scriptsDir, { recursive: true });
      await mkdir(workflowsDir, { recursive: true });
      await writeFile(join(scriptsDir, 'verify.ts'), 'console.log(process.env.NAME)\n');
      await writeFile(
        join(workflowsDir, 'uses-configured-env.yaml'),
        `name: uses-configured-env
description: Reads a variable supplied by config.yaml's env section
inputs:
  declared: {}
nodes:
  - id: verify
    script: verify
    runtime: bun
`
      );
      const { captureWorkflowSource, capturedSourceRoots, DEFAULT_WORKFLOW_SOURCE_CONFIG } =
        await import('./workflow-source');
      const capture = await captureWorkflowSource({
        sourceRoot: testDir,
        captureRoot: join(testDir, 'home', 'staged-source', 'run-1'),
        sourceConfig: { ...DEFAULT_WORKFLOW_SOURCE_CONFIG, env_var_names: ['NAME'] },
      });
      // A run that already froze its source never calls loadConfig again (see
      // discoverWorkflowsWithConfig) — proving this stays unbound-env-clean without it is
      // what distinguishes this test from the live-config one above.
      const loadConfigShouldNotRun = mock(async () => {
        throw new Error('loadConfig must not run once a frozen source config is already known');
      });

      const result = await discoverWorkflowsWithConfig(
        testDir,
        loadConfigShouldNotRun,
        providerRegistry,
        capturedSourceRoots(capture.anchor)
      );

      expect(loadConfigShouldNotRun).not.toHaveBeenCalled();
      expect(result.errors).toEqual([]);
      const entry = result.workflows.find(w => w.workflow.name === 'uses-configured-env');
      expect(entry).toBeDefined();
      expect(entry?.parseWarnings ?? []).toEqual([]);
    });

    it('should pass loadDefaults from config to discoverWorkflows', async () => {
      const { discoverWorkflowsWithConfig } = await import('./workflow-discovery');
      const mockLoadConfig = mock(async () => ({
        defaults: { loadDefaultWorkflows: false },
      }));

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig, providerRegistry);

      expect(result.workflows.find(w => w.workflow.name === 'fake-review')).toBeUndefined();
      expect(mockLoadConfig).toHaveBeenCalledWith(testDir);
    });

    it('rejects with the config error instead of listing with defaults', async () => {
      const { discoverWorkflowsWithConfig } = await import('./workflow-discovery');
      const configError = new Error("Invalid model binding config in 'config.yaml': tiers.medium");
      const mockLoadConfig = mock(async () => {
        throw configError;
      });

      await expect(
        discoverWorkflowsWithConfig(testDir, mockLoadConfig, providerRegistry)
      ).rejects.toBe(configError);
    });

    it('surfaces home-scoped workflows without any option — discovery reads ~/.archon/workflows/ internally', async () => {
      const { discoverWorkflowsWithConfig } = await import('./workflow-discovery');

      const homeDir = join(
        tmpdir(),
        `home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const homeWorkflowDir = join(homeDir, 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await writeFile(
        join(homeWorkflowDir, 'home-only.yaml'),
        'name: home-only\ndescription: From home\nnodes:\n  - id: foo\n    command: foo\n'
      );

      const originalArchonHome = process.env.ARCHON_HOME;
      const originalArchonDocker = process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = homeDir;
      delete process.env.ARCHON_DOCKER;
      try {
        const mockLoadConfig = mock(async () => ({
          defaults: { loadDefaultWorkflows: false },
        }));

        const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig, providerRegistry);
        const entry = result.workflows.find(w => w.workflow.name === 'home-only');
        expect(entry).toBeDefined();
        expect(entry?.source).toBe('global');
      } finally {
        if (originalArchonHome === undefined) {
          delete process.env.ARCHON_HOME;
        } else {
          process.env.ARCHON_HOME = originalArchonHome;
        }
        if (originalArchonDocker === undefined) {
          delete process.env.ARCHON_DOCKER;
        } else {
          process.env.ARCHON_DOCKER = originalArchonDocker;
        }
        await removeTempTree(homeDir);
      }
    });
  });

  describe('error accumulation', () => {
    it('should return errors for YAML missing name', async () => {
      await writeWorkflowFile(
        testDir,
        'invalid.yaml',
        'description: Missing name\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('invalid.yaml');
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('name');
    });

    it('should load valid workflows and report errors for invalid ones', async () => {
      await writeWorkflowFile(
        testDir,
        'good.yaml',
        'name: good\ndescription: Works\nnodes:\n  - id: plan\n    command: plan\n'
      );
      await writeWorkflowFile(
        testDir,
        'bad.yaml',
        'description: Bad name type\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.name).toBe('good');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('bad.yaml');
    });

    it('should return empty errors array when all workflows are valid', async () => {
      await writeWorkflowFile(
        testDir,
        'valid.yaml',
        'name: valid\ndescription: Valid\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty errors when no workflows exist', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should report YAML parse errors', async () => {
      await writeWorkflowFile(testDir, 'broken.yaml', 'name: test\ninvalid: [');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('broken.yaml');
      expect(result.errors[0].errorType).toBe('parse_error');
      expect(result.errors[0].error).toContain('YAML parse error');
    });

    it('should accumulate errors from subdirectories', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const subDir = join(workflowDir, 'sub');
      await mkdir(subDir, { recursive: true });

      // Invalid in root
      await writeFile(
        join(workflowDir, 'root-bad.yaml'),
        'description: No name\nnodes:\n  - id: plan\n    command: plan\n'
      );
      // Invalid in subdirectory
      await writeFile(
        join(subDir, 'sub-bad.yaml'),
        'name: sub\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(2);
      const filenames = result.errors.map(e => e.filename).sort();
      expect(filenames).toEqual(['root-bad.yaml', 'sub-bad.yaml']);
    });

    it('should report validation error for empty YAML content', async () => {
      await writeWorkflowFile(testDir, 'empty.yaml', '');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('empty.yaml');
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('empty');
    });

    it('should report validation error for YAML that parses to non-object', async () => {
      await writeWorkflowFile(testDir, 'scalar.yaml', 'just a string');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('scalar.yaml');
      expect(result.errors[0].error).toContain('empty');
    });

    it.skipIf(isWindows)(
      'should report directory read errors for non-ENOENT failures',
      async () => {
        const workflowDir = join(testDir, '.archon', 'workflows');
        await mkdir(workflowDir, { recursive: true });

        // Create a file where a directory is expected (causes ENOTDIR on readdir)
        await writeFile(join(workflowDir, 'not-a-dir'), 'file content');

        // Create a YAML file that references the fake dir as a subdirectory
        // The loader recurses into directories, so create a setup that triggers readdir error
        // Simplest: create a workflow dir, then a symlink to nowhere
        const brokenLink = join(workflowDir, 'broken-subdir');
        const { symlink } = await import('fs/promises');
        await symlink('/nonexistent/path', brokenLink);

        const result = await discoverWorkflows(testDir, { loadDefaults: false });

        // The symlink stat will fail, producing a read_error
        const readErrors = result.errors.filter(e => e.errorType === 'read_error');
        expect(readErrors.length).toBeGreaterThanOrEqual(1);
      }
    );
  });

  describe('discoverWorkflows with null cwd (no project context)', () => {
    it('skips project scope and returns no project-source workflows', async () => {
      // When no codebase is registered the LIST endpoint passes null so bundled
      // + home scopes can still surface. Discovery must not attempt to read a
      // cwd-derived path and must not produce project-source entries.
      const result = await discoverWorkflows(null, { loadDefaults: false });

      // loadDefaults:false skips bundled and a clean test env has no home-
      // scoped workflows, so the full result must be empty — without this the
      // test would pass even if a stray project-path read were silently injected.
      expect(result.workflows).toHaveLength(0);

      const projectSourced = result.workflows.filter(w => w.source === 'project');
      expect(projectSourced).toHaveLength(0);

      // No project-step file/dir read errors — we never tried to access a project path.
      const readErrors = result.errors.filter(e => e.errorType === 'read_error');
      expect(readErrors).toHaveLength(0);
    });

    it('still loads bundled defaults when loadDefaults:true and cwd is null', async () => {
      const result = await discoverWorkflows(null, { loadDefaults: true });

      // No project-source entries (project step skipped).
      const projectSourced = result.workflows.filter(w => w.source === 'project');
      expect(projectSourced).toHaveLength(0);

      // Bundled-source entries must surface — without this assertion the test
      // would silently pass even if the bundled-defaults loader regressed.
      const bundledSourced = result.workflows.filter(w => w.source === 'bundled');
      expect(bundledSourced.length).toBeGreaterThan(0);
    });

    it('discoverWorkflowsWithConfig does not call loadConfig when cwd is null', async () => {
      // The per-project config opt-out must not be evaluated when there is no
      // project context — running loadConfig with no cwd would silently apply
      // home-dir or working-dir defaults to a request that has neither.
      const mockLoadConfig = mock(async () => ({ defaults: { loadDefaultWorkflows: true } }));
      await discoverWorkflowsWithConfig(null, mockLoadConfig, providerRegistry);
      expect(mockLoadConfig).not.toHaveBeenCalled();
    });
  });

  describe('include: warnings stay with the file that declared the key (#2213)', () => {
    // Pins CURRENT behaviour, which is a known gap documented in the authoring
    // guide: warnings are keyed by the file they were parsed from, so an
    // included block's unknown key is reported against the BLOCK, never against
    // the workflow that includes it. Propagating across the include boundary is
    // a deliberate follow-up — this test exists so that change is a visible,
    // intentional edit rather than a silent behaviour shift.
    it('reports on the included block, not the includer', async () => {
      await writeWorkflowFile(
        testDir,
        'block.yaml',
        [
          'name: block',
          'description: shared block',
          'nodes:',
          '  - id: work',
          '    prompt: do it',
          '    contxt: fresh', // dropped, warned — on THIS file
        ].join('\n')
      );
      await writeWorkflowFile(
        testDir,
        'parent.yaml',
        [
          'name: parent',
          'description: includes the block',
          'nodes:',
          '  - id: blk',
          '    include: block',
        ].join('\n')
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const byName = new Map(result.workflows.map(w => [w.workflow.name, w]));

      const block = byName.get('block');
      expect((block?.parseWarnings ?? []).length).toBe(1);
      expect(block?.parseWarnings?.[0]).toContain("unknown key 'contxt'");

      // The includer inlines the block's NODES but not its warnings.
      const parent = byName.get('parent');
      expect(parent).toBeDefined();
      expect(parent?.parseWarnings ?? []).toEqual([]);
    });
  });

  describe('parse warnings survive a filename collision (#2213)', () => {
    // Discovery keys files by BARE filename, so `foo.yaml` at the root and
    // `foo.yaml` in a 1-level subfolder (a supported layout) collide, and the
    // loser is dropped. `readdir()` order decides which one wins, so these
    // assert the ORDER-INDEPENDENT invariant instead of a fixed winner: the
    // warnings that survive must describe the workflow that survived. Before
    // the single-entry refactor the definition and the warnings came from two
    // parallel maps, and a clean file could inherit the dropped file's warning.
    //
    // READ THIS BEFORE TRUSTING THE PAIR: only ONE of these two is a live
    // regression test on any given platform, and which one depends on the
    // filesystem. The bug was that warnings were sticky — set, never cleared —
    // so it is only observable when the CLEAN file wins: post-fix its warnings
    // are empty, pre-fix it inherited the dirty file's. When the DIRTY file
    // wins, pre-fix and post-fix produce the same correct warning, so that
    // direction cannot distinguish them and passes either way. There is no
    // assertion that fixes this; it is inherent to the bug's shape.
    //
    // Forcing both orderings would need a test seam in `loadWorkflowsFromDir`
    // or a `mock.module('fs/promises')` that would break the real-I/O tests
    // throughout this file. Judged not worth it (#2455 review S5) — but do not
    // read this as two regression tests, because it is one plus a companion.
    const CLEAN = (name: string): string =>
      ['name: ' + name, 'description: test', 'nodes:', '  - id: a', '    prompt: hi'].join('\n');
    const DIRTY = (name: string): string =>
      [
        'name: ' + name,
        'description: test',
        'nodes:',
        '  - id: a',
        '    prompt: hi',
        '    contxt: fresh',
      ].join('\n');

    /** Write root/sub `foo.yaml`, discover, and return the single survivor. */
    const discoverColliding = async (
      rootYaml: string,
      subYaml: string
    ): Promise<{ name: string; warnings: string[] }> => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(join(workflowDir, 'zsub'), { recursive: true });
      await writeFile(join(workflowDir, 'foo.yaml'), rootYaml);
      await writeFile(join(workflowDir, 'zsub', 'foo.yaml'), subYaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // One filename → one surviving entry, whichever side won.
      expect(result.workflows.length).toBe(1);
      return {
        name: result.workflows[0].workflow.name,
        warnings: [...(result.workflows[0].parseWarnings ?? [])],
      };
    };

    it('does not attach the dropped file’s warning to a clean survivor', async () => {
      const { name, warnings } = await discoverColliding(CLEAN('foo-root'), DIRTY('foo-sub'));
      if (name === 'foo-root') {
        expect(warnings).toEqual([]); // the clean file won — it declares no unknown key
      } else {
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("unknown key 'contxt'");
      }
    });

    it('does not drop a dirty survivor’s warning when a clean file collides', async () => {
      const { name, warnings } = await discoverColliding(DIRTY('foo-root'), CLEAN('foo-sub'));
      if (name === 'foo-root') {
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("unknown key 'contxt'");
      } else {
        expect(warnings).toEqual([]);
      }
    });
  });
});
