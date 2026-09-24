/**
 * Installed workflow packs in the one catalog: every consumer resolves them through
 * `discoverWorkflowsWithConfig`, only manifest entrypoints are dispatchable, and a run
 * keeps the pack bytes it captured.
 *
 * Packs are written the way `archon plugin install` leaves them (a receipt under
 * `plugins/installed/` and a tree under `plugins/packs/`) into a temp ARCHON_HOME.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { trackTempRoots } from '@archon/paths/test-utils';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { findWorkflow, resolveWorkflowName } from './router';
import { validateWorkflowResources } from './validator';
import { loadCommandPrompt } from './executor-shared';
import { discoverScriptsForCwd } from './script-discovery';
import { resolveContinuationWorkflow } from './executor';
import { resolveFanOutChildDefinition } from './dag-executor';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  resolveChildInstalledPacks,
  type WorkflowSourceCapture,
} from './workflow-source';
import { WORKFLOW_SOURCE_METADATA_KEY } from './schemas/workflow-run';
import { isAgentNode, type ResolvedWorkflow } from './schemas';
import type { WorkflowDeps } from './deps';

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
}

/** Write a pack exactly where `archon plugin install` puts one. */
async function install(pack: PackFixture): Promise<void> {
  const pluginsDir = join(home, 'plugins');
  const manifest = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: pack.name,
    description: 'fixture pack',
    entrypoints: pack.entrypoints,
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
  discoverWorkflowsWithConfig(project, loadConfig);
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
    expect(workflows.find(entry => entry.workflow.name === 'archon-assist')?.source).toBe(
      'bundled'
    );
  });

  test('consumer parity: run, routing, validation and resume resolve the same installed workflow', async () => {
    await install(reviewKit());
    const { workflows } = await discover();
    const definitions = workflows.map(entry => entry.workflow);

    // Explicit run (CLI, API, chat, run management, resume) resolves through
    // resolveWorkflowName; chat routing's /invoke-workflow through findWorkflow.
    expect(resolveWorkflowName(REVIEW, definitions)?.name).toBe(REVIEW);
    expect(findWorkflow(REVIEW, definitions)?.name).toBe(REVIEW);
    // Neither a support workflow nor a guess reaches past the entrypoints.
    expect(resolveWorkflowName(HELPER, definitions)).toBeUndefined();
    expect(findWorkflow(HELPER, definitions)).toBeUndefined();

    // Validation resolves the pack's own command and script.
    const review = resolveWorkflowName(REVIEW, definitions) as ResolvedWorkflow;
    const issues = await validateWorkflowResources(review, project, {
      workflowSource: 'installed',
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

  test('a composed fan-out body may be a support workflow; a fan-out child run may not', async () => {
    await install(reviewKit());
    await expect(
      resolveFanOutChildDefinition(deps, project, HELPER, 'include')
    ).resolves.toMatchObject({ definition: { name: HELPER } });
    await expect(
      resolveFanOutChildDefinition(deps, project, HELPER, 'workflow')
    ).resolves.toMatchObject({ unresolved: expect.any(String) });
    await expect(
      resolveFanOutChildDefinition(deps, project, REVIEW, 'workflow')
    ).resolves.toMatchObject({ definition: { name: REVIEW } });
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
    expect(resolveWorkflowName('ACME/review-kit:review', definitions)?.name).toBe(REVIEW);
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
