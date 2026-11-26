// @archon-test-isolated
/**
 * Installed workflow packs in the one catalog: every consumer resolves them through
 * `discoverWorkflowsWithConfig`, only manifest entrypoints are dispatchable, and a run
 * keeps the pack bytes it captured.
 *
 * Packs are written the way `archon plugin add` leaves them (a receipt under
 * `plugins/installed/` and a tree under `plugins/packs/`) into a temp ARCHON_HOME.
 */
import { providerRegistry, claudeDescriptor } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { readHomeMcpDirectory } from './compiled-command';
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { resolveWorkflowName } from './router';
import { validateWorkflowResources } from './validator';
import { loadCommandPrompt } from './load-command-prompt';
import { discoverScriptsForCwd } from './script-discovery';
import { resolveContinuationWorkflow } from './run-source';
import { resolveFanOutChildDefinition } from './dag/nodes/compose-fan-out/compose-fan-out';
import { packCopies, packWorkflows } from './pack-graph';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  liveSourceRoots,
  packDirectory,
  resolveChildInstalledPacks,
  type WorkflowSourceCapture,
} from './workflow-source';
import { WORKFLOW_SOURCE_METADATA_KEY } from './schemas/workflow-run';
import { isAgentNode, type ResolvedWorkflow, type WorkflowPack } from './schemas';
import type { WorkflowDeps } from './deps';
import * as bundleInventory from './defaults/bundle-inventory';

// A fake bundled pack stands in for the shipped one. Its workflow declares an MCP file
// so the checkout-only MCP assertion below has a bundled node to hold to.
const bundleRoot = await mkdtemp(join(tmpdir(), 'installed-packs-bundle-'));
afterAll(() => removeTempTree(bundleRoot));
await mkdir(join(bundleRoot, 'fake', 'review'), { recursive: true });
await writeFile(
  join(bundleRoot, 'fake', 'review', 'fake-review.yaml'),
  'name: fake-review\ndescription: Bundled review\nnodes:\n  - id: check\n    prompt: Check\n    mcp: servers.json\n'
);
const actualPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...actualPaths,
  getBundledWorkflowsPath: () => bundleRoot,
}));
spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue(['fake']);

const trackTempRoot = trackTempRoots();
const loadConfig = async (): Promise<Record<string, never>> => ({});
const deps = { loadConfig } as unknown as WorkflowDeps;

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const ID = 'acme/packs/review-kit';
const REVIEW = 'acme/review-kit:review';
const HELPER = 'acme/review-kit:helper';

let home: string;
let project: string;
let previousHome: string | undefined;

interface PackFixture {
  id: string;
  name: string;
  commit: string;
  entrypoints: Record<string, string>;
  files: Record<string, string>;
  /** Keys a newer Archon would write into the manifest and the receipt. */
  newerKeys?: true;
}

/** Write a pack exactly where `archon plugin add` puts one. */
async function install(pack: PackFixture): Promise<void> {
  const pluginsDir = join(home, 'plugins');
  const manifest = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: pack.name,
    description: 'fixture pack',
    entrypoints: pack.entrypoints,
    ...(pack.newerKeys && { skills: ['review'], compatibility: { archon: '>=0.1.0', min: 1 } }),
  };
  const tree = packTreePath(pluginsDir, pack.id, pack.commit);
  for (const [path, content] of Object.entries({
    ...pack.files,
    'archon-plugin.json': JSON.stringify(manifest),
  })) {
    await mkdir(dirname(join(tree, path)), { recursive: true });
    await writeFile(join(tree, path), content);
  }
  const receipt = receiptPath(pluginsDir, pack.id);
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(
    receipt,
    JSON.stringify({
      schemaVersion: 1,
      id: pack.id,
      manifest,
      commit: pack.commit,
      installedAt: new Date(0).toISOString(),
      ...(pack.newerKeys && { installedBy: '0.99.0' }),
    })
  );
}

async function uninstall(id: string, commit: string): Promise<void> {
  await rm(receiptPath(join(home, 'plugins'), id));
  await rm(packTreePath(join(home, 'plugins'), id, commit), { recursive: true });
}

/**
 * review-kit: the `review` entrypoint uses its own command and script and includes the
 * `helper` support workflow, which has a command of its own.
 */
function reviewKit(commit = COMMIT_A, marker = 'v1'): PackFixture {
  return {
    id: ID,
    name: 'review-kit',
    commit,
    entrypoints: { review: 'review/code-review.yaml' },
    files: {
      'review/code-review.yaml': `name: code-review
description: Review a change (${marker})
nodes:
  - id: scope
    command: scope
  - id: helper
    include: helper
    depends_on: [scope]
  - id: check
    script: check
    runtime: bun
    depends_on: [helper]
`,
      'review/commands/scope.md': `Scope the change (${marker}).\n`,
      'review/scripts/check.ts': 'console.log("ok");\n',
      'helper/helper.yaml': `name: helper
description: Support workflow
nodes:
  - id: summarize
    command: summarize
`,
      'helper/commands/summarize.md': 'Summarize.\n',
      '.shared/util.ts': 'export const util = 1;\n',
    },
  };
}

const discover = (): ReturnType<typeof discoverWorkflowsWithConfig> =>
  discoverWorkflowsWithConfig(project, loadConfig, providerRegistry);
const names = (entries: readonly { workflow: { name: string } }[]): string[] =>
  entries.map(entry => entry.workflow.name);

beforeEach(async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'installed-packs-')));
  home = join(root, 'home');
  project = join(root, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

describe('installed packs in the catalog', () => {
  test('a broken pack affects only the workflows that name it, in the run and its children', async () => {
    await install(reviewKit());
    await writeFile(
      join(packTreePath(join(home, 'plugins'), ID, COMMIT_A), 'archon-plugin.json'),
      '{bad json'
    );
    const folder = join(project, '.archon/workflows');
    await writeFile(
      join(folder, 'deploy.yaml'),
      'name: deploy\ndescription: Deploy\nnodes:\n  - id: ship\n    bash: echo ship\n'
    );
    await writeFile(
      join(folder, 'shadow.yaml'),
      `name: ${REVIEW}\ndescription: Shadow\nnodes:\n  - id: wrong\n    bash: echo wrong\n`
    );
    const parent = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'parent'),
    });
    const installedFrom = await resolveChildInstalledPacks(runWith(parent, 'deploy').metadata);
    const child = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'child'),
      ...(installedFrom ? { installedFrom } : {}),
    });
    for (const capture of [parent, child]) {
      const catalog = await discoverWorkflowsWithConfig(
        project,
        loadConfig,
        providerRegistry,
        capturedSourceRoots(capture.anchor)
      );
      expect(names(catalog.workflows)).toContain('deploy');
      expect(names(catalog.workflows)).not.toContain(REVIEW);
      expect(catalog.errors.some(error => error.workflowName === REVIEW)).toBe(true);
    }
  });

  test('installed MCP declarations stay checkout-only despite adjacent and home configs', async () => {
    registerBuiltinProviders();
    await install({
      id: ID,
      name: 'review-kit',
      commit: COMMIT_A,
      entrypoints: { review: 'review/review.yaml' },
      files: {
        'review/review.yaml': `name: review
description: Installed MCP
nodes:
  - id: check
    prompt: Check
    mcp: servers.json
`,
        'review/servers.json': '{"installed":{"command":"example"}}',
      },
    });
    await mkdir(join(home, 'workflows'), { recursive: true });
    await writeFile(join(home, 'workflows', 'servers.json'), '{"home":{"command":"example"}}');
    const catalog = await discover();
    expect(catalog.errors).toEqual([]);
    const entry = catalog.workflows.find(e => e.workflow.name === REVIEW);
    if (!entry) throw new Error('Missing installed workflow');
    expect(entry.source).toBe('installed');
    expect(readHomeMcpDirectory(entry.workflow.nodes[0])).toBeUndefined();
    const issues = (
      await validateWorkflowResources(entry.workflow, project, providerRegistry)
    ).filter(i => i.field === 'mcp');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      `MCP config file not found: 'servers.json'. Tried: ${join(project, 'servers.json')}`
    );
    const bundled = catalog.workflows.find(e => e.workflow.name === 'fake-review');
    expect(bundled?.source).toBe('bundled');
    expect(bundled?.workflow.nodes.map(node => readHomeMcpDirectory(node))).toEqual([undefined]);
  });

  test('an installed pack is keyed owner.<manifest name>, and its workflows keep their authored names in it', async () => {
    const kit = reviewKit();
    await install({
      ...kit,
      files: { ...kit.files, '.pack/pack.yaml': 'inputs:\n  depth:\n    default: shallow\n' },
    });
    const { workflows, support } = await discover();
    const review = workflows.find(entry => entry.workflow.name === REVIEW);
    const expected: WorkflowPack = {
      key: 'acme.review-kit',
      source: 'installed',
      settings: { depth: { type: 'string', default: 'shallow' } },
    };
    // The `review` entrypoint publishes `name: code-review`; within the pack it stays that.
    expect(review?.workflow.pack).toEqual({ ...expected, workflow: 'code-review' });
    expect(support?.find(entry => entry.workflow.name === HELPER)?.workflow.pack).toEqual({
      ...expected,
      workflow: 'helper',
    });
  });

  test('entrypoints are dispatchable as owner/plugin:entrypoint; support workflows only compose', async () => {
    await install(reviewKit());
    const { workflows, support, errors } = await discover();
    expect(errors.filter(error => error.filename.includes('review-kit'))).toEqual([]);

    const review = workflows.find(entry => entry.workflow.name === REVIEW);
    expect(review?.source).toBe('installed');
    // The support workflow's nodes are inlined through its include.
    expect(review?.workflow.nodes.map(node => node.id)).toEqual([
      'scope',
      'helper__summarize',
      'check',
    ]);
    expect(names(workflows)).not.toContain(HELPER);
    expect(names(workflows)).not.toContain('helper');
    expect(names(workflows)).not.toContain('code-review');
    expect(names(support ?? [])).toEqual([HELPER]);
    // Bundled workflows are still there, as before.
    expect(workflows.find(entry => entry.workflow.name === 'fake-review')?.source).toBe('bundled');
  });

  test('a pack and receipt written with keys this Archon does not know still load', async () => {
    await install({ ...reviewKit(), newerKeys: true });
    const { workflows, errors } = await discover();
    expect(errors).toEqual([]);
    expect(workflows.find(entry => entry.workflow.name === REVIEW)?.source).toBe('installed');
  });

  test('consumer parity: run, routing, validation and resume resolve the same installed workflow', async () => {
    await install(reviewKit());
    const { workflows } = await discover();
    const definitions = workflows.map(entry => entry.workflow);

    // Explicit run (CLI, API, chat, run management, resume) resolves through
    // resolveWorkflowName.
    expect(resolveWorkflowName(REVIEW, definitions)?.name).toBe(REVIEW);
    // Neither a support workflow nor a guess reaches past the entrypoints.
    expect(resolveWorkflowName(HELPER, definitions)).toBeUndefined();

    // Validation resolves the pack's own command and script.
    const review = resolveWorkflowName(REVIEW, definitions) as ResolvedWorkflow;
    const issues = await validateWorkflowResources(review, project, providerRegistry, {
      workflowSource: 'installed',
      assistant: 'claude',
    });
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    const scope = review.nodes.find(node => node.id === 'scope');
    if (!scope || !isAgentNode(scope) || scope.source.kind !== 'command') {
      throw new Error('scope is a command node');
    }
    const live = await loadCommandPrompt(deps, project, scope.source.name);
    expect(live).toEqual({ success: true, content: 'Scope the change (v1).\n' });
    const scripts = await discoverScriptsForCwd(project);
    expect(
      [...scripts.values()].some(script => script.path.endsWith('review/scripts/check.ts'))
    ).toBe(true);

    // Resume: the run captured its source, then the plugin was removed.
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    await uninstall(ID, COMMIT_A);
    expect(names((await discover()).workflows)).not.toContain(REVIEW);
    const resumed = await resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project);
    expect(resumed?.workflow.name).toBe(REVIEW);
    expect(
      await loadCommandPrompt(deps, project, scope.source.name, undefined, resumed?.roots)
    ).toEqual({ success: true, content: 'Scope the change (v1).\n' });
  });

  test('a capture holds no .env file from any scope, and its source still resolves', async () => {
    await install(reviewKit());
    const installedTree = packTreePath(join(home, 'plugins'), ID, COMMIT_A);
    await writeFile(join(installedTree, 'review', '.env'), 'SECRET=1\n');
    await mkdir(join(project, '.archon', 'scripts'), { recursive: true });
    await writeFile(join(project, '.archon', 'scripts', '.env'), 'SECRET=1\n');
    await writeFile(join(project, '.archon', 'scripts', 'local.ts'), 'console.log("ok");\n');
    await mkdir(join(home, 'scripts'), { recursive: true });
    await writeFile(join(home, 'scripts', '.env.local'), 'SECRET=1\n');
    await writeFile(join(home, 'scripts', 'global.ts'), 'console.log("ok");\n');

    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    const frozen = capture.anchor.root;
    for (const left of [
      'project/.archon/scripts/.env',
      'global/scripts/.env.local',
      'installed/acme.review-kit/review/.env',
    ]) {
      await expect(access(join(frozen, left))).rejects.toThrow();
    }
    for (const kept of [
      'project/.archon/scripts/local.ts',
      'global/scripts/global.ts',
      'installed/acme.review-kit/review/scripts/check.ts',
    ]) {
      await access(join(frozen, kept));
    }

    await uninstall(ID, COMMIT_A);
    const resumed = await resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project);
    expect(resumed?.workflow.name).toBe(REVIEW);
  });

  test('a run resumes on the bytes it captured after the plugin is updated', async () => {
    await install(reviewKit(COMMIT_A, 'v1'));
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    expect(capture.manifest).toMatchObject({
      version: 2,
      scopes: expect.arrayContaining(['installed']),
      installed_plugins: [{ key: 'acme.review-kit', id: ID, commit: COMMIT_A }],
    });

    await uninstall(ID, COMMIT_A);
    await install(reviewKit(COMMIT_B, 'v2'));
    const live = (await discover()).workflows.find(entry => entry.workflow.name === REVIEW);
    expect(live?.workflow.description).toBe('Review a change (v2)');
    const resumed = await resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project);
    expect(resumed?.workflow.description).toBe('Review a change (v1)');
  });

  test("a workflow: child takes its installed packs from the parent's capture", async () => {
    await install(reviewKit(COMMIT_A, 'v1'));
    const parent = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'parent'),
    });
    await uninstall(ID, COMMIT_A);
    await install(reviewKit(COMMIT_B, 'v2'));

    const installedFrom = await resolveChildInstalledPacks(runWith(parent, REVIEW).metadata);
    const child = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'child'),
      ...(installedFrom ? { installedFrom } : {}),
    });
    expect(child.manifest).toMatchObject({
      version: 2,
      installed_plugins: [{ id: ID, commit: COMMIT_A }],
    });
    const { workflows } = await discoverWorkflowsWithConfig(
      project,
      loadConfig,
      providerRegistry,
      capturedSourceRoots(child.anchor)
    );
    expect(workflows.find(entry => entry.workflow.name === REVIEW)?.workflow.description).toBe(
      'Review a change (v1)'
    );
  });

  test('a capture with no installed pack stays manifest version 1', async () => {
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    expect(capture.manifest.version).toBe(1);
    expect(capture.manifest.scopes).not.toContain('installed');
  });
});

describe('installed pack boundaries', () => {
  test('an incompatible provider receipt is excluded from workflow load errors', async () => {
    await install(reviewKit());
    const file = receiptPath(join(home, 'plugins'), 'owner/stale-provider');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: 'owner/stale-provider',
        tag: 'v0.13.0',
        manifest: {
          schemaVersion: 1,
          kind: 'provider',
          name: 'stale-provider',
          description: 'test',
          executable: 'archon-provider-claude',
        },
        commit: COMMIT_A,
        installedAt: new Date(0).toISOString(),
        files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
        descriptor: { ...claudeDescriptor, protocol: 2 },
      })
    );
    const { workflows, errors } = await discover();
    expect(names(workflows)).toContain(REVIEW);
    expect(errors).toEqual([]);
  });

  test('another pack and a project workflow cannot include a support workflow', async () => {
    await install(reviewKit());
    await install({
      id: 'other/repo',
      name: 'borrower',
      commit: COMMIT_A,
      entrypoints: { go: 'go/go.yaml', qualified: 'qualified/qualified.yaml' },
      files: {
        'go/go.yaml': 'name: go\ndescription: d\nnodes:\n  - id: h\n    include: helper\n',
        'qualified/qualified.yaml': `name: qualified\ndescription: d\nnodes:\n  - id: h\n    include: ${HELPER}\n`,
      },
    });
    await writeFile(
      join(project, '.archon', 'workflows', 'reach.yaml'),
      `name: reach\ndescription: d\nnodes:\n  - id: h\n    include: ${HELPER}\n`
    );
    const { workflows, errors } = await discover();
    expect(names(workflows)).not.toContain('other/borrower:go');
    expect(names(workflows)).not.toContain('other/borrower:qualified');
    expect(names(workflows)).not.toContain('reach');
    expect(errors.some(error => error.filename.startsWith('other/borrower/go'))).toBe(true);
    expect(names(workflows)).toContain(REVIEW);
  });

  test('a workflow: child inside a pack may launch an entrypoint but not a support workflow', async () => {
    await install({
      id: 'acme/kids',
      name: 'kids',
      commit: COMMIT_A,
      entrypoints: { parent: 'parent/parent.yaml', launch: 'launch/launch.yaml' },
      files: {
        'parent/parent.yaml':
          'name: parent\ndescription: d\nnodes:\n  - id: run-launch\n    workflow: launch\n',
        'launch/launch.yaml':
          'name: launch\ndescription: d\nnodes:\n  - id: run-helper\n    workflow: helper\n',
        'helper/helper.yaml': 'name: helper\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n',
      },
    });
    const { workflows, errors } = await discover();
    const parent = workflows.find(entry => entry.workflow.name === 'acme/kids:parent');
    expect(parent?.workflow.nodes[0]).toMatchObject({ workflow: 'acme/kids:launch' });
    expect(names(workflows)).not.toContain('acme/kids:launch');
    expect(
      errors.find(error => error.filename === 'acme/kids/launch/launch.yaml')?.error
    ).toContain("support workflow 'helper'");
  });

  test('a composed fan-out body may be a support workflow', async () => {
    await install(reviewKit());
    await expect(resolveFanOutChildDefinition(deps, project, HELPER)).resolves.toMatchObject({
      definition: { name: HELPER },
    });
  });

  test('a qualified name never falls through to a longer name or a copy', async () => {
    await install(reviewKit());
    await writeFile(
      join(project, '.archon', 'workflows', 'copy.yaml'),
      'name: review-kit-review\ndescription: a copy\nnodes:\n  - id: a\n    bash: echo\n'
    );
    await install({
      ...reviewKit(),
      id: 'acme/packs/review-kit-extended',
      name: 'review-kit-extended',
    });
    const definitions = (await discover()).workflows.map(entry => entry.workflow);
    expect(resolveWorkflowName('acme/review-kit:rev', definitions)).toBeUndefined();
    expect(resolveWorkflowName('acme/review:review', definitions)).toBeUndefined();
    expect(resolveWorkflowName('ACME/review-kit:review', definitions)).toBeUndefined();
  });

  test('a project workflow cannot shadow an installed name', async () => {
    await install(reviewKit());
    await writeFile(
      join(project, '.archon', 'workflows', 'shadow.yaml'),
      `name: ${REVIEW}\ndescription: shadow\nnodes:\n  - id: a\n    bash: echo\n`
    );
    const { workflows, errors } = await discover();
    const matches = workflows.filter(entry => entry.workflow.name === REVIEW);
    expect(matches.map(entry => entry.source)).toEqual(['installed']);
    expect(errors.find(error => error.filename === REVIEW)?.error).toContain(
      'belongs to an installed plugin'
    );
  });

  test('a manifest naming one file twice is reported, not silently narrowed to one name', async () => {
    await install({
      ...reviewKit(),
      id: 'acme/twice',
      name: 'twice',
      entrypoints: { review: 'review/code-review.yaml', again: 'review/code-review.yaml' },
    });
    const { workflows, errors } = await discover();
    expect(names(workflows).filter(name => name.startsWith('acme/twice:'))).toEqual([]);
    expect(
      errors.some(error => error.error.includes('each entrypoint must name a different workflow'))
    ).toBe(true);
  });

  // A pack installed from a repository root carries that repository's other
  // directories. Neither a dot directory nor one with no YAML can be a workflow folder.
  test('ordinary repository directories in a pack root are not workflow folders', async () => {
    await install({
      ...reviewKit(),
      files: {
        ...reviewKit().files,
        '.github/workflows/ci.yml': 'name: ci\non: push\n',
        'tests/test_x.py': 'def test_x(): pass\n',
        'crowded/one.yaml': 'name: one\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n',
        'crowded/two.yaml': 'name: two\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n',
      },
    });
    const { workflows, errors } = await discover();
    expect(names(workflows)).toContain(REVIEW);
    expect(errors.filter(error => error.filename.startsWith('acme/review-kit/'))).toEqual([
      {
        filename: 'acme/review-kit/crowded',
        error:
          "Packaged workflow 'acme/review-kit/crowded' must contain exactly one .yaml or .yml file (found 2).",
        errorType: 'validation_error',
      },
    ]);
  });

  test('files at a pack root are not workflows, installed or copied into a project', async () => {
    const pack = {
      ...reviewKit(),
      files: {
        ...reviewKit().files,
        'README.md': '# review-kit\n',
        'example.yaml': 'model: sonnet\n',
      },
    };
    // Bundled defaults report their own errors in this isolated process; only the pack's count.
    const packErrors = (errors: readonly { filename: string }[]): unknown[] =>
      errors.filter(error => !error.filename.startsWith('archon-'));
    await install(pack);
    const installed = await discover();
    expect(packErrors(installed.errors)).toEqual([]);
    expect(names(installed.workflows)).toContain(REVIEW);

    // `archon plugin copy`: the installed tree, verbatim, at `.archon/workflows/<name>/`.
    await cp(
      packTreePath(join(home, 'plugins'), pack.id, pack.commit),
      join(project, '.archon', 'workflows', pack.name),
      { recursive: true }
    );
    await uninstall(pack.id, pack.commit);
    const copied = await discover();
    expect(packErrors(copied.errors)).toEqual([]);
    expect(names(copied.workflows)).toEqual(expect.arrayContaining(['code-review', 'helper']));
  });

  test('an unreadable pack is reported without hiding the others', async () => {
    await install(reviewKit());
    await install({ ...reviewKit(), id: 'broken/repo', name: 'broken' });
    await rm(
      join(packTreePath(join(home, 'plugins'), 'broken/repo', COMMIT_A), 'archon-plugin.json')
    );
    const { workflows, errors } = await discover();
    expect(names(workflows)).toContain(REVIEW);
    expect(errors.some(error => error.error.includes('archon-plugin.json'))).toBe(true);
  });
});

/** A run row that recorded `capture` as its source. */
describe('a pack folder given as the source', () => {
  /** A pack author's checkout of review-kit: the pack's own files, manifest at the root. */
  async function packFolder(marker: string, extra: object = {}): Promise<string> {
    const kit = reviewKit(COMMIT_B, marker);
    const dir = join(dirname(project), 'review-kit-checkout');
    for (const [path, content] of Object.entries({
      ...kit.files,
      'archon-plugin.json': JSON.stringify({
        schemaVersion: 1,
        kind: 'workflow-pack',
        name: kit.name,
        description: 'fixture pack',
        entrypoints: kit.entrypoints,
        ...extra,
      }),
    })) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }
  const discoverFrom = (source: string): ReturnType<typeof discoverWorkflowsWithConfig> =>
    discoverWorkflowsWithConfig(source, loadConfig, providerRegistry);

  test('is the project pack that runs, live and from its capture, beside the installed copy', async () => {
    await install(reviewKit(COMMIT_A, 'installed'));
    const folder = await packFolder('local');

    const live = await discoverFrom(folder);
    // Like the installed copy, only the file the manifest lists dispatches, here under its
    // authored name; the workflow it includes is support, and the include still expands.
    const local = live.workflows.find(entry => entry.workflow.name === 'code-review');
    expect(names(live.workflows)).not.toContain('helper');
    expect(names(live.support ?? [])).toContain('helper');
    expect(local?.workflow.nodes.some(node => node.id === 'helper__summarize')).toBe(true);
    expect(local?.source).toBe('project');
    expect(local?.workflow.pack?.key).toBe('review-kit');
    expect(local?.workflow.description).toBe('Review a change (local)');
    // The installed copy is still in reach under its own name and bytes.
    const installed = live.workflows.find(entry => entry.workflow.name === REVIEW);
    expect(installed?.workflow.description).toBe('Review a change (installed)');

    // Commands and scripts of the local pack resolve from the folder.
    expect(
      await packDirectory(liveSourceRoots(folder), { source: 'project', key: 'review-kit' })
    ).toBe(folder);
    const scope = local?.workflow.nodes.find(node => node.id === 'scope');
    if (!scope || !isAgentNode(scope) || scope.source.kind !== 'command') {
      throw new Error('scope is a command node');
    }
    expect(await loadCommandPrompt(deps, folder, scope.source.name)).toEqual({
      success: true,
      content: 'Scope the change (local).\n',
    });
    // Script discovery reports paths with forward slashes on every platform.
    const checkScript = join(folder, 'review', 'scripts', 'check.ts').replaceAll('\\', '/');
    expect(
      [...(await discoverScriptsForCwd(folder)).values()].some(
        script => script.path === checkScript
      )
    ).toBe(true);

    // A run freezes the folder and resumes on those bytes. The folder's `.archon/.env` is
    // project secrets, not pack source, and stays out of the capture.
    await mkdir(join(folder, '.archon'), { recursive: true });
    await writeFile(join(folder, '.archon', '.env'), 'SECRET=1\n');
    const capture = await captureWorkflowSource({
      sourceRoot: folder,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    await expect(access(join(capture.anchor.root, 'project', '.archon', '.env'))).rejects.toThrow();
    await writeFile(join(folder, 'review', 'commands', 'scope.md'), 'Edited after start.\n');
    const resumed = await resolveContinuationWorkflow(
      deps,
      runWith(capture, 'code-review'),
      folder
    );
    expect(resumed?.workflow.pack).toMatchObject({ key: 'review-kit', source: 'project' });
    expect(
      await loadCommandPrompt(deps, folder, scope.source.name, undefined, resumed?.roots)
    ).toEqual({ success: true, content: 'Scope the change (local).\n' });
  });

  test('loads when its manifest carries keys this Archon does not know', async () => {
    const folder = await packFolder('local', { skills: ['review'] });
    const live = await discoverFrom(folder);
    expect(live.errors).toEqual([]);
    expect(live.workflows.find(entry => entry.workflow.name === 'code-review')?.source).toBe(
      'project'
    );
  });

  test('names the copy it read and the other copy, and how to name each', async () => {
    await install(reviewKit());
    const folder = await packFolder('local');
    const discovered = await discoverFrom(folder);
    const roots = liveSourceRoots(folder);
    const installedDir = packTreePath(join(home, 'plugins'), ID, COMMIT_A);

    expect(await packCopies(discovered, roots, 'review-kit')).toEqual({
      loaded: [{ source: 'project', key: 'review-kit', dir: folder }],
      otherCopies: [{ source: 'installed', key: 'acme.review-kit', dir: installedDir }],
    });
    expect(await packCopies(discovered, roots, 'acme.review-kit')).toEqual({
      loaded: [{ source: 'installed', key: 'acme.review-kit', dir: installedDir }],
      otherCopies: [{ source: 'project', key: 'review-kit', dir: folder }],
    });
    // From a project without the folder, asking for the bare name points at the installed key.
    expect(() => packWorkflows(discovered, 'review-kit', folder)).not.toThrow();
    expect(() => packWorkflows(discovered, 'acme.review-kit', folder)).not.toThrow();
    const elsewhere = await discover();
    expect(() => packWorkflows(elsewhere, 'review-kit', project)).toThrow(
      "Pack 'review-kit' is in reach as 'acme.review-kit' (installed); name 'acme.review-kit' to use it."
    );
  });

  test('refuses a child run of its support workflow and reports a listed file that is missing', async () => {
    const folder = await packFolder('local', {
      entrypoints: {
        review: 'review/code-review.yaml',
        launch: 'launch/launch.yaml',
        gone: 'gone/gone.yaml',
        // Its filename exists, but in another folder: the path decides, not the filename.
        elsewhere: 'elsewhere/helper.yaml',
      },
    });
    await mkdir(join(folder, 'launch'), { recursive: true });
    await writeFile(
      join(folder, 'launch', 'launch.yaml'),
      'name: launch\ndescription: d\nnodes:\n  - id: child\n    workflow: helper\n'
    );
    const live = await discoverFrom(folder);
    expect(names(live.workflows)).not.toContain('launch');
    expect(names(live.workflows)).not.toContain('helper');
    const messages = live.errors.map(error => error.error);
    expect(messages).toContainEqual(
      expect.stringContaining("'workflow:' launches support workflow 'helper'")
    );
    const gone = "Entrypoint 'gone' of pack folder review-kit did not load from gone/gone.yaml.";
    expect(messages.filter(message => message === gone)).toHaveLength(1);
  });

  /** A pack folder holding `files`, with a manifest naming it `name`. */
  async function rawPackFolder(name: string, files: Record<string, string>): Promise<string> {
    const dir = join(dirname(project), `${name}-checkout`);
    for (const [path, content] of Object.entries({
      ...files,
      'archon-plugin.json': JSON.stringify({
        schemaVersion: 1,
        kind: 'workflow-pack',
        name,
        description: 'fixture pack',
        entrypoints: { one: 'one/workflow.yaml' },
      }),
    })) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }
  const flow = (name: string): string =>
    `name: ${name}\ndescription: d\nnodes:\n  - id: a\n    bash: echo ${name}\n`;

  test('two workflow files with one filename fail live as they fail from the capture', async () => {
    const folder = await rawPackFolder('twin-kit', {
      'one/workflow.yaml': flow('one'),
      'two/workflow.yaml': flow('two'),
    });
    const collision = expect.stringContaining('Workflow filename collision');
    const live = await discoverFrom(folder);
    expect(live.workflows.some(entry => entry.workflow.pack?.key === 'twin-kit')).toBe(false);
    expect(live.errors.map(error => error.error)).toContainEqual(collision);

    const capture = await captureWorkflowSource({
      sourceRoot: folder,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    const captured = await discoverWorkflowsWithConfig(
      folder,
      loadConfig,
      providerRegistry,
      capturedSourceRoots(capture.anchor)
    );
    expect(captured.workflows.some(entry => entry.workflow.pack?.key === 'twin-kit')).toBe(false);
    expect(captured.errors.map(error => error.error)).toContainEqual(collision);
  });

  test('a pack named like a reserved project folder loads live and from its capture', async () => {
    // Project data in the same-named workflows directory is not a second copy of the pack.
    const projectData: Record<string, Record<string, string>> = {
      defaults: { '.archon/workflows/defaults/legacy.yaml': flow('legacy') },
      fixtures: { '.archon/workflows/fixtures/extra.stubs.yaml': 'nodes: {}\n' },
    };
    for (const name of ['defaults', 'fixtures']) {
      const folder = await rawPackFolder(name, {
        'one/workflow.yaml': flow('one'),
        ...projectData[name],
      });
      const ownWorkflow = (result: Awaited<ReturnType<typeof discoverFrom>>): unknown =>
        result.workflows.find(entry => entry.workflow.name === 'one')?.workflow.pack;
      const live = await discoverFrom(folder);
      expect(ownWorkflow(live)).toMatchObject({ key: name, source: 'project' });
      const roots = liveSourceRoots(folder);
      expect((await packCopies(live, roots, name)).loaded).toEqual([
        { source: 'project', key: name, dir: folder },
      ]);
      expect(await packDirectory(roots, { source: 'project', key: name })).toBe(folder);

      const capture = await captureWorkflowSource({
        sourceRoot: folder,
        captureRoot: join(home, 'runs', name),
      });
      const captured = await discoverWorkflowsWithConfig(
        folder,
        loadConfig,
        providerRegistry,
        capturedSourceRoots(capture.anchor)
      );
      expect(ownWorkflow(captured)).toMatchObject({ key: name, source: 'project' });
    }
  });

  test('a folder that also holds a nested copy of its pack loads neither copy', async () => {
    const folder = await packFolder('local');
    const nested = join(folder, '.archon', 'workflows', 'review-kit', 'review');
    await mkdir(nested, { recursive: true });
    await cp(join(folder, 'review'), nested, { recursive: true });
    await writeFile(join(folder, '.archon', 'workflows', 'other.yaml'), flow('other'));
    const neither = expect.stringContaining('Neither copy is loaded');
    const reads = (result: Awaited<ReturnType<typeof discoverFrom>>) => ({
      pack: result.workflows.some(entry => entry.workflow.pack?.key === 'review-kit'),
      other: result.workflows.some(entry => entry.workflow.name === 'other'),
      errors: result.errors.map(error => error.error),
    });
    const live = reads(await discoverFrom(folder));
    expect(live).toMatchObject({ pack: false, other: true });
    expect(live.errors).toContainEqual(neither);

    // The capture does not refuse: its run reads the same error, and the rest still starts.
    const capture = await captureWorkflowSource({
      sourceRoot: folder,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    const captured = reads(
      await discoverWorkflowsWithConfig(
        folder,
        loadConfig,
        providerRegistry,
        capturedSourceRoots(capture.anchor)
      )
    );
    expect(captured).toMatchObject({ pack: false, other: true });
    expect(captured.errors).toContainEqual(neither);
  });

  test("a malformed root manifest leaves the project's other packs' scripts and commands", async () => {
    const folder = join(dirname(project), 'malformed-checkout');
    const team = join(folder, '.archon', 'workflows', 'team');
    await mkdir(join(team, 'wf', 'scripts'), { recursive: true });
    await writeFile(join(folder, 'archon-plugin.json'), '{ not json');
    await writeFile(join(team, 'wf', 'wf.yaml'), flow('wf'));
    await writeFile(join(team, 'wf', 'scripts', 'check.ts'), 'console.log(1);\n');

    const checkScript = join(team, 'wf', 'scripts', 'check.ts').replaceAll('\\', '/');
    expect(
      [...(await discoverScriptsForCwd(folder)).values()].some(
        script => script.path === checkScript
      )
    ).toBe(true);
    expect(await packDirectory(liveSourceRoots(folder), { source: 'project', key: 'team' })).toBe(
      team
    );
  });

  test('a capture from a git checkout of a pack holds what an install would, and no .env', async () => {
    const folder = await packFolder('local');
    await writeFile(join(folder, '.gitignore'), 'node_modules/\nbuild/\n');
    await mkdir(join(folder, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(folder, 'node_modules', 'dep', 'index.js'), 'ignored\n');
    await mkdir(join(folder, 'build'), { recursive: true });
    await writeFile(join(folder, 'build', 'out.txt'), 'ignored\n');
    await writeFile(join(folder, '.env'), 'SECRET=1\n');
    await writeFile(join(folder, 'review', '.env.local'), 'SECRET=1\n');
    await mkdir(join(folder, 'policy'), { recursive: true });
    await writeFile(join(folder, 'policy', 'build.md'), 'untracked, not ignored\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: folder });
    Bun.spawnSync(['git', 'add', 'archon-plugin.json', 'review'], { cwd: folder });

    const capture = await captureWorkflowSource({
      sourceRoot: folder,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    const frozen = join(capture.anchor.root, 'project');
    for (const kept of ['archon-plugin.json', 'review/code-review.yaml', 'policy/build.md']) {
      await access(join(frozen, kept));
    }
    for (const left of ['node_modules', 'build', '.env', 'review/.env.local']) {
      await expect(access(join(frozen, left))).rejects.toThrow();
    }
  });
});

function runWith(
  capture: WorkflowSourceCapture,
  workflowName: string
): { workflow_name: string; metadata: Record<string, unknown> } {
  return {
    workflow_name: workflowName,
    metadata: {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: capture.anchor.root,
        origin: capture.origin,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        source_config: capture.manifest.source_config,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    },
  };
}
