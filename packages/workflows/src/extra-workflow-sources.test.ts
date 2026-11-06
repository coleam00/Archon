// @archon-test-isolated
/**
 * Workflows read from a git ref of the project's own repository: syncing a ref into a
 * snapshot, discovering from it, and freezing it into a run's capture.
 */
import { execFileAsync } from '@archon/git';
import { providerRegistry } from '@archon/providers';
import { readBundleIndex } from './defaults/bundle-inventory';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// The capture also freezes the bundled scope; empty indexed packs keep these tests about
// the extra source, as in workflow-source.test.ts.
const bundledDefaultsRoot = join(tmpdir(), `extra-sources-test-empty-bundled-${process.pid}`);
await mkdir(join(bundledDefaultsRoot, 'defaults'), { recursive: true });
for (const pack of await readBundleIndex())
  await mkdir(join(bundledDefaultsRoot, pack), { recursive: true });
afterAll(async () => {
  await rm(bundledDefaultsRoot, { recursive: true, force: true }).catch(() => {});
});
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  getBundledWorkflowsPath: () => bundledDefaultsRoot,
}));

import { captureWorkflowSource, capturedSourceRoots } from './workflow-source';
import {
  ExtraSourceNotSyncedError,
  readExtraSourceSnapshot,
  syncExtraSource,
} from './workflow-source/extra-sources';
import { extraWorkflowSourceSchema, type ExtraWorkflowSource } from './schemas/run-metadata';
import { discoverWorkflows } from './workflow-discovery';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const PLANS: ExtraWorkflowSource = { ref: 'plans', path: '.' };

const workflowYaml = (name: string, description: string): string =>
  `name: ${name}\ndescription: ${description}\nnodes:\n  - id: hold\n    bash: "echo ${name}"\n`;

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args]);
  return stdout.trim();
}

/** A repository on `main` with a `plans` branch holding `workflows/plan.yaml`. */
async function createRepository(): Promise<{ project: string; home: string }> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-extra-')));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await git(project, 'init', '-q', '-b', 'main');
  await git(project, 'config', 'user.email', 'test@example.com');
  await git(project, 'config', 'user.name', 'Test');
  await writeFile(join(project, 'README.md'), 'code\n');
  await git(project, 'add', '.');
  await git(project, 'commit', '-q', '-m', 'code');

  await git(project, 'checkout', '-q', '--orphan', 'plans');
  await git(project, 'rm', '-rfq', '.');
  await mkdir(join(project, 'workflows'), { recursive: true });
  await writeFile(join(project, 'workflows', 'plan.yaml'), workflowYaml('plan', 'plan v1'));
  await git(project, 'add', '.');
  await git(project, 'commit', '-q', '-m', 'plan v1');
  await git(project, 'checkout', '-q', 'main');
  return { project, home: join(root, 'home') };
}

async function pushPlan(project: string, description: string): Promise<void> {
  await git(project, 'checkout', '-q', 'plans');
  await writeFile(join(project, 'workflows', 'plan.yaml'), workflowYaml('plan', description));
  await git(project, 'commit', '-q', '-am', description);
  await git(project, 'checkout', '-q', 'main');
}

let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.ARCHON_HOME;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

describe('syncExtraSource', () => {
  test('snapshots the ref without touching the checkout', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;

    const result = await syncExtraSource(project, PLANS);

    expect(result.commit).toBe(await git(project, 'rev-parse', 'plans'));
    expect(result.fetched).toBe(false);
    const snapshot = await readExtraSourceSnapshot(project, PLANS);
    expect(snapshot?.meta.commit).toBe(result.commit);
    expect(await readFile(join(snapshot!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v1');
    expect(await git(project, 'branch', '--show-current')).toBe('main');
    expect(await git(project, 'status', '--porcelain')).toBe('');
  });

  test('a push to the ref changes nothing until the next sync', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const first = await syncExtraSource(project, PLANS);

    await pushPlan(project, 'plan v2');
    const before = await readExtraSourceSnapshot(project, PLANS);
    expect(before?.meta.commit).toBe(first.commit);
    expect(await readFile(join(before!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v1');

    const second = await syncExtraSource(project, PLANS);
    expect(second.commit).not.toBe(first.commit);
    const after = await readExtraSourceSnapshot(project, PLANS);
    expect(await readFile(join(after!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v2');
  });

  test('a ref that does not exist fails and names it', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await expect(syncExtraSource(project, { ref: 'missing', path: '.' })).rejects.toThrow(
      /"missing" does not exist/
    );
    expect(await readExtraSourceSnapshot(project, { ref: 'missing', path: '.' })).toBeUndefined();
  });

  test('a path without a workflows folder fails instead of syncing nothing', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await expect(syncExtraSource(project, { ref: 'main', path: '.' })).rejects.toThrow(
      /no "workflows\/" folder/
    );
  });

  test('a symlink in the ref is refused', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await git(project, 'checkout', '-q', 'plans');
    await symlink('plan.yaml', join(project, 'workflows', 'link.yaml'));
    await git(project, 'add', '.');
    await git(project, 'commit', '-q', '-m', 'link');
    await git(project, 'checkout', '-q', 'main');
    await expect(syncExtraSource(project, PLANS)).rejects.toThrow(/symlink/);
  });
});

describe('the config entry', () => {
  test('defaults the path and rejects what leaves the repository', () => {
    expect(extraWorkflowSourceSchema.parse({ ref: 'plans' })).toEqual({ ref: 'plans', path: '.' });
    for (const bad of [
      { ref: 'plans', path: '../outside' },
      { ref: 'plans', path: '/etc' },
      { ref: 'plans', path: 'C:\\x' },
      { ref: '--upload-pack=x', path: '.' },
      { ref: 'has space', path: '.' },
      { ref: 'plans', path: '.', extra: 1 },
    ]) {
      expect(extraWorkflowSourceSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('discovery from an extra source', () => {
  const options = (extraSources: readonly ExtraWorkflowSource[]) => ({
    providers: providerRegistry,
    loadDefaults: false,
    extraSources,
  });

  test('lists the synced workflows as project workflows', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await syncExtraSource(project, PLANS);

    const result = await discoverWorkflows(project, options([PLANS]));

    const plan = result.workflows.find(entry => entry.workflow.name === 'plan');
    expect(plan?.source).toBe('project');
    expect(result.errors).toEqual([]);
  });

  test('a project file of the same name wins', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await syncExtraSource(project, PLANS);
    await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(project, '.archon', 'workflows', 'plan.yaml'),
      workflowYaml('plan', 'from the project')
    );

    const result = await discoverWorkflows(project, options([PLANS]));

    const plans = result.workflows.filter(entry => entry.workflow.name === 'plan');
    expect(plans.map(entry => entry.workflow.description)).toEqual(['from the project']);
  });

  test('a source that was never synced is a load error that names the fix', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;

    const result = await discoverWorkflows(project, options([PLANS]));

    expect(result.workflows.find(entry => entry.workflow.name === 'plan')).toBeUndefined();
    expect(result.errors.map(error => error.error).join('\n')).toContain('archon workflow sync');
  });

  test('a project with no extra sources behaves as before', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const result = await discoverWorkflows(project, options([]));
    expect(result.workflows).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('a run captures the extra source', () => {
  const sourceConfig = {
    load_default_workflows: false,
    load_default_commands: false,
    extra_sources: [PLANS],
  };

  test('later pushes and syncs never reach a captured run', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const first = await syncExtraSource(project, PLANS);
    const captureRoot = join(dirname(home), 'captures', 'run-1');
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot,
      sourceConfig,
    });
    expect(capture.manifest.scopes).toContain('extra');
    const recorded = JSON.parse(
      await readFile(join(captureRoot, 'extra', '0', 'source.json'), 'utf8')
    ) as { commit: string };
    expect(recorded.commit).toBe(first.commit);

    await pushPlan(project, 'plan v2');
    await syncExtraSource(project, PLANS);

    const frozen = await discoverWorkflows(project, {
      providers: providerRegistry,
      sourceRoots: capturedSourceRoots(capture.anchor),
    });
    expect(
      frozen.workflows
        .filter(entry => entry.workflow.name === 'plan')
        .map(e => e.workflow.description)
    ).toEqual(['plan v1']);
  });

  test('a configured source that was never synced fails the capture', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await expect(
      captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(dirname(home), 'captures', 'run-2'),
        sourceConfig,
      })
    ).rejects.toBeInstanceOf(ExtraSourceNotSyncedError);
  });
});
