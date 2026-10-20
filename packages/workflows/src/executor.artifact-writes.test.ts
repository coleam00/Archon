// @archon-test-isolated
import {
  containerBackend,
  cwdPath,
  mockExecuteDagWorkflow,
  resetExecutorMocks,
  startWorkflow,
} from './executor/test-utils';
import * as checkout from './checkout-observation';
import { removeTempTree } from '@archon/paths/test-utils';
import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'path';
import { ArtifactWriteError } from './artifact-writes';
import { writeNodeArtifact } from './artifacts-index';
import { CHECKOUT_MANIFEST_VERSION } from './schemas/checkout-observation';

beforeEach(resetExecutorMocks);

describe('artifact writes under executor isolation', () => {
  // The container mounts the run's artifacts directory read-write; a host run's
  // writes keep their plain filesystem behaviour.
  for (const isolation of ['container', 'host'] as const) {
    it(`${isolation === 'container' ? 'checks' : 'does not check'} DAG artifact writes for links in a ${isolation} run`, async () => {
      const outside = await mkdtemp(join(tmpdir(), 'executor-artifact-link-'));
      let planted: string | undefined;
      let write: Promise<unknown> | undefined;
      mockExecuteDagWorkflow.mockImplementationOnce(async options => {
        await mkdir(options.artifactsDir, { recursive: true });
        planted = join(options.artifactsDir, 'nodes');
        await symlink(outside, planted);
        write = writeNodeArtifact(
          options.artifactsDir,
          {
            nodeId: 'probe',
            outputType: 'text',
            runId: 'run-123',
            producedAt: '2026-10-20T00:00:00Z',
          },
          'output'
        ).catch((error: unknown) => error);
        await write;
        return undefined;
      });
      try {
        await startWorkflow({
          cwd: '/tmp/ops',
          options:
            isolation === 'container'
              ? {
                  execContext: { kind: 'container', containerId: 'cid' },
                  container: { envId: 'env-x', writeBack: 'approve', backend: containerBackend() },
                }
              : {},
        });
        if (isolation === 'container') {
          expect(await write).toBeInstanceOf(ArtifactWriteError);
          expect(await readdir(outside)).toEqual([]);
        } else {
          // readdir order is filesystem-defined, so compare the sorted names.
          expect((await readdir(outside)).sort()).toEqual(['probe.md', 'probe.meta.json']);
        }
      } finally {
        if (planted !== undefined) await rm(planted, { force: true });
        await removeTempTree(outside);
      }
    });
  }

  // The checkout baseline and the credential clear run before the DAG, under the same
  // scope. A refused write fails the run without reaching the planted link's target.
  it.each([
    { site: 'checkout baseline', planted: join('.archon', 'checkout') },
    { site: 'credential clear', planted: 'codex-home' },
  ])('checks the $site of a container run for planted links', async ({ planted }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-artifact-checkout-'));
    const link = join(cwdPath(cwd, 'artifacts', 'runs', 'run-123'), planted);
    const outside = await mkdtemp(join(tmpdir(), 'executor-artifact-link-'));
    await writeFile(join(outside, 'auth.json'), 'host secret');
    await mkdir(dirname(link), { recursive: true });
    await symlink(outside, link);
    const sampler = spyOn(checkout, 'sampleCheckout').mockResolvedValue({
      observation: { kind: 'git', sampledAt: '2026-10-20T00:00:00Z', commit: null, tree: null },
      worktree: {
        status: 'dirty',
        manifest: {
          version: CHECKOUT_MANIFEST_VERSION,
          objectFormat: 'sha1',
          commit: null,
          entries: [],
        },
        staged: 0,
        unstaged: 1,
        untracked: 0,
      },
    });
    try {
      const result = await startWorkflow({
        cwd,
        options: {
          execContext: { kind: 'container', containerId: 'cid' },
          container: { envId: 'env-x', writeBack: 'approve', backend: containerBackend() },
        },
      });
      expect(result.success).toBe(false);
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      expect(await readdir(outside)).toEqual(['auth.json']);
      expect(await readFile(join(outside, 'auth.json'), 'utf8')).toBe('host secret');
    } finally {
      sampler.mockRestore();
      await rm(link, { force: true });
      await removeTempTree(cwdPath(cwd));
      await removeTempTree(cwd);
      await removeTempTree(outside);
    }
  });
});
