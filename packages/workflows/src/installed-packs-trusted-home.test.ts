/**
 * Installed packs are read from the plugins directory of the trusted ARCHON_HOME, the
 * one `archon plugin install` wrote to, even when a repository's `.archon/.env`
 * points ARCHON_HOME somewhere else.
 *
 * Its own file (and test group): `loadArchonEnv` pins the trusted home for the whole
 * process, which the other installed-pack tests must not inherit.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { getPluginsPath, loadArchonEnv } from '@archon/paths';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { captureWorkflowSource } from './workflow-source';

const COMMIT = 'c'.repeat(40);
const ID = 'acme/packs/review-kit';
const previousHome = process.env.ARCHON_HOME;
const root = await mkdtemp(join(tmpdir(), 'installed-packs-trusted-'));

afterAll(async () => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  await removeTempTree(root);
});

describe('installed packs and a repository-scoped ARCHON_HOME', () => {
  test('discovery and capture read the plugins directory install wrote to', async () => {
    const trustedHome = join(root, 'trusted-home');
    const repoHome = join(root, 'repo-chosen-home');
    const project = join(root, 'project');
    await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
    await writeFile(join(project, '.archon', '.env'), `ARCHON_HOME=${repoHome}\n`);

    // Installed where `archon plugin install` writes: the trusted home's plugins dir.
    const pluginsDir = join(trustedHome, 'plugins');
    const manifest = {
      schemaVersion: 1,
      kind: 'workflow-pack',
      name: 'review-kit',
      description: 'fixture',
      entrypoints: { review: 'review/review.yaml' },
    };
    const tree = packTreePath(pluginsDir, ID, COMMIT);
    await mkdir(join(tree, 'review'), { recursive: true });
    await writeFile(join(tree, 'archon-plugin.json'), JSON.stringify(manifest));
    await writeFile(
      join(tree, 'review', 'review.yaml'),
      'name: review\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n'
    );
    const receipt = receiptPath(pluginsDir, ID);
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        id: ID,
        manifest,
        commit: COMMIT,
        installedAt: new Date(0).toISOString(),
      })
    );

    process.env.ARCHON_HOME = trustedHome;
    loadArchonEnv(project);
    // The repository moved ARCHON_HOME; the plugins directory stays the trusted one.
    expect(process.env.ARCHON_HOME).toBe(repoHome);
    expect(getPluginsPath()).toBe(pluginsDir);

    const { workflows } = await discoverWorkflowsWithConfig(project, async () => ({}));
    expect(workflows.map(entry => entry.workflow.name)).toContain('acme/review-kit:review');

    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(root, 'capture'),
    });
    expect(capture.manifest).toMatchObject({
      version: 2,
      installed_plugins: [{ id: ID, commit: COMMIT }],
    });
  });
});
