import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  ARTIFACT_POINTER_TYPE,
  validateArtifactPointers,
  type ArtifactPointer,
} from './artifact-pointer';
import type { WorkflowRun } from './schemas';

/**
 * #2453 — an artifact pointer is a run id plus a relative path. The producing node proves
 * it against its OWN run, once: this run's id, a regular file that exists under this run's
 * artifacts directory. No store is consulted; reachability and physical resolution belong
 * to the read side.
 */
describe('artifact pointers (#2453)', () => {
  let home: string;
  let outputRoot: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  function makeRun(id: string, overrides?: Partial<WorkflowRun>): WorkflowRun {
    return {
      id,
      workflow_name: 'wf',
      conversation_id: 'conv',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      outcome: null,
      user_message: 'msg',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: outputRoot,
      ...overrides,
    };
  }

  /** This run's artifacts directory, laid out exactly as the executor writes it. */
  function artifactsDir(runId: string): string {
    return join(outputRoot, 'artifacts', 'runs', runId);
  }

  async function writeArtifact(runId: string, relPath: string, body = 'contents'): Promise<void> {
    const full = join(artifactsDir(runId), relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  }

  const pointer = (runId: string, path: string): ArtifactPointer => ({
    type: ARTIFACT_POINTER_TYPE,
    run_id: runId,
    path,
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'artifact-pointer-'));
    process.env.ARCHON_HOME = home;
    outputRoot = join(home, 'workspaces', '_cwd', 'proj');
  });

  afterEach(async () => {
    await removeTempTree(home);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  describe('which run a pointer may name', () => {
    it('accepts a pointer at the current run whose target is an existing regular file', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      // The run in hand is all the validation needs: no store, no lookup.
      expect(
        await validateArtifactPointers(
          { ready: true, plan: pointer('run-self', 'plan.md') },
          current
        )
      ).toBeNull();
    });

    it('rejects a pointer at any other run, even when that file exists', async () => {
      const current = makeRun('run-a');
      await writeArtifact('run-b', 'plan.md');

      const result = await validateArtifactPointers(pointer('run-b', 'plan.md'), current);

      expect(result).toContain("a result may only point at its own run's artifacts today");
      expect(result).toContain("run 'run-b'");
      expect(result).toContain("this run is 'run-a'");
    });

    it('rejects a pointer when this run never recorded its artifacts location', async () => {
      const current = makeRun('run-self', { output_root: null });

      expect(await validateArtifactPointers(pointer('run-self', 'plan.md'), current)).toContain(
        'output_root is null'
      );
    });

    it('rejects a pointer when this run recorded a location outside the Archon home', async () => {
      const current = makeRun('run-self', { output_root: join(tmpdir(), 'somewhere-else') });

      expect(await validateArtifactPointers(pointer('run-self', 'plan.md'), current)).toContain(
        'outside the Archon home directory'
      );
    });
  });

  describe('which paths a pointer may name', () => {
    it('rejects an absolute path', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      expect(
        await validateArtifactPointers(
          pointer('run-self', join(artifactsDir('run-self'), 'plan.md')),
          current
        )
      ).toContain('must use a path relative');
    });

    it('rejects a traversal segment', async () => {
      const current = makeRun('run-self');

      expect(
        await validateArtifactPointers(pointer('run-self', '../../plan.md'), current)
      ).toContain("may not contain '..' path segments");
    });

    it('rejects a NUL byte', async () => {
      const current = makeRun('run-self');

      expect(
        await validateArtifactPointers(pointer('run-self', 'plan.md\0.txt'), current)
      ).toContain('contains a NUL byte');
    });

    it('rejects a file that does not exist', async () => {
      const current = makeRun('run-self');
      await mkdir(artifactsDir('run-self'), { recursive: true });

      expect(await validateArtifactPointers(pointer('run-self', 'nope.md'), current)).toContain(
        'refers to a file that does not exist'
      );
    });

    it('rejects a directory', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', join('review', 'report.md'));

      expect(await validateArtifactPointers(pointer('run-self', 'review'), current)).toContain(
        'does not refer to a regular file'
      );
    });

    it('rejects an empty file, since a pointer must name evidence', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', join('review', 'report.md'), '');

      expect(
        await validateArtifactPointers(pointer('run-self', 'review/report.md'), current)
      ).toContain('refers to an empty file');
    });

    it('accepts a nested relative path', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', join('review', 'report.md'));

      expect(
        await validateArtifactPointers(pointer('run-self', 'review/report.md'), current)
      ).toBeNull();
    });
  });

  describe('where pointers are found in a value', () => {
    it('validates pointers nested in arrays and objects', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      const value = {
        units: [
          { name: 'a', plan: pointer('run-self', 'plan.md') },
          { name: 'b', plan: pointer('run-self', 'missing.md') },
        ],
      };

      expect(await validateArtifactPointers(value, current)).toContain(
        'the artifact pointer at $.units[1].plan'
      );
    });

    it('rejects an object that claims the reserved tag but is not a pointer', async () => {
      const current = makeRun('run-self');

      const result = await validateArtifactPointers(
        { plan: { type: ARTIFACT_POINTER_TYPE, run_id: 'run-self' } },
        current
      );

      expect(result).toContain('$.plan is tagged');
      expect(result).toContain('An artifact pointer is');
    });

    it('tolerates extra keys beside the three engine-owned fields', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      expect(
        await validateArtifactPointers(
          { plan: { ...pointer('run-self', 'plan.md'), label: 'the plan' } },
          current
        )
      ).toBeNull();
    });

    it('never resolves a root for a value carrying no pointer', async () => {
      // A run with no recorded location would reject any pointer; a value with none
      // passes without the root ever being consulted.
      const current = makeRun('run-self', { output_root: null });

      expect(
        await validateArtifactPointers(
          { ready: true, units: ['a', 'b'], nested: { type: 'plan', note: null } },
          current
        )
      ).toBeNull();
    });
  });
});
