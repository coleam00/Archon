import { execFileAsync } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearPlatformPolicies, setPlatformPolicies } from '../platforms/registry';
import { listExtraSources, syncConfiguredExtraSources } from './extra-sources';

const trackTempRoot = trackTempRoots();

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args]);
  return stdout.trim();
}

/** A repository whose `.archon/config.yaml` is `config`, with a `plans` branch of workflows. */
async function createProject(config: string | null): Promise<string> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-extra-')));
  const project = join(root, 'project');
  await mkdir(join(project, '.archon'), { recursive: true });
  await git(project, 'init', '-q', '-b', 'main');
  await git(project, 'config', 'user.email', 'test@example.com');
  await git(project, 'config', 'user.name', 'Test');
  if (config !== null) await writeFile(join(project, '.archon', 'config.yaml'), config);
  await writeFile(join(project, 'README.md'), 'code\n');
  await git(project, 'add', '.');
  await git(project, 'commit', '-q', '-m', 'code');

  await git(project, 'checkout', '-q', '--orphan', 'plans');
  await git(project, 'rm', '-rfq', '.');
  await mkdir(join(project, 'workflows'), { recursive: true });
  await writeFile(
    join(project, 'workflows', 'plan.yaml'),
    'name: plan\ndescription: a plan\nnodes:\n  - id: a\n    bash: "echo plan"\n'
  );
  await git(project, 'add', '.');
  await git(project, 'commit', '-q', '-m', 'plan');
  await git(project, 'checkout', '-q', 'main');
  // The config lives on main; switching branches removed it from the working tree.
  if (config !== null) await writeFile(join(project, '.archon', 'config.yaml'), config);
  return project;
}

let previousHome: string | undefined;
beforeEach(async () => {
  // Loading config requires the host to have registered its platform policies.
  setPlatformPolicies([]);
  previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-home-')));
});
afterEach(() => {
  clearPlatformPolicies();
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

describe('extra workflow sources from the project config', () => {
  test('are listed unsynced, then with the commit a sync wrote', async () => {
    const project = await createProject('extraWorkflowSources:\n  - ref: plans\n');

    expect(await listExtraSources(project)).toEqual([
      { source: { ref: 'plans', path: '.' }, snapshot: null },
    ]);

    const [synced] = await syncConfiguredExtraSources(project);
    const [listed] = await listExtraSources(project);

    expect(synced?.commit).toBe(await git(project, 'rev-parse', 'plans'));
    expect(listed?.snapshot?.commit).toBe(synced?.commit);
  });

  test('a project that configures none lists and syncs nothing', async () => {
    const project = await createProject(null);
    expect(await listExtraSources(project)).toEqual([]);
    expect(await syncConfiguredExtraSources(project)).toEqual([]);
  });

  test('a configured ref that does not exist fails the sync and names the ref', async () => {
    const project = await createProject('extraWorkflowSources:\n  - ref: nope\n');
    await expect(syncConfiguredExtraSources(project)).rejects.toThrow(/"nope"/);
  });
});
