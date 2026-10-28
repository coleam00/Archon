import { describe, test, expect, beforeEach } from 'bun:test';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { createHash } from 'node:crypto';
import { getProjectArtifactsPath, getStoragePathsForRoot } from './project-paths';
import {
  getRunArtifactsPath,
  getRunLogPath,
  getScopeArtifactsPath,
  resolveRunStorageRoot,
  getRunArtifactsDirForKey,
  getRunArtifactsDirForRoot,
  getRunLogPathForRoot,
  getRunWorkflowSourceDirForRoot,
  getFolderRunArtifactsPath,
} from './run-paths';
import { usePathEnvSnapshot } from './test-utils';

const cwdDigest = (cwd: string): string => createHash('sha256').update(resolve(cwd)).digest('hex');

describe('run-paths', () => {
  usePathEnvSnapshot();

  describe('resolveRunStorageRoot', () => {
    beforeEach(() => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
    });

    test('keeps a trusted persisted root when the codebase was renamed', () => {
      const root = join('/custom/archon', 'workspaces', 'acme', 'original');
      expect(
        resolveRunStorageRoot(
          { output_root: root },
          { kind: 'repo', name: 'acme/renamed', default_cwd: '/repos/renamed' }
        )
      ).toBe(root);
    });

    test('re-derives an out-of-tree persisted root under the current home', () => {
      expect(
        resolveRunStorageRoot(
          { output_root: '/previous/archon/home/workspaces/_local/workspace' },
          { kind: 'repo', name: 'workspace', default_cwd: '/home/u/workspace' }
        )
      ).toBe(join('/custom/archon', 'workspaces', '_local', 'workspace'));
    });

    test('rejects an untrusted root when no codebase can re-derive it', () => {
      expect(resolveRunStorageRoot({ output_root: '/etc' }, null)).toBeNull();
    });
  });

  describe('getRunArtifactsDirForKey', () => {
    beforeEach(() => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
    });

    test('matches getRunArtifactsPath for a repo key', () => {
      expect(
        getRunArtifactsDirForKey({ kind: 'repo', owner: 'acme', repo: 'widget' }, 'run-1')
      ).toBe(getRunArtifactsPath('acme', 'widget', 'run-1'));
    });

    test('matches getFolderRunArtifactsPath for a folder key', () => {
      expect(getRunArtifactsDirForKey({ kind: 'folder', slug: 'ops' }, 'run-1')).toBe(
        getFolderRunArtifactsPath('ops', 'run-1')
      );
    });

    test('resolves a cwd key under @cwd, separated by run id', () => {
      expect(getRunArtifactsDirForKey({ kind: 'cwd', cwd: '/home/u/scratch' }, 'run-1')).toBe(
        join(
          '/custom/archon',
          'workspaces',
          '@cwd',
          `scratch-${cwdDigest('/home/u/scratch')}`,
          'artifacts',
          'runs',
          'run-1'
        )
      );
    });
  });

  describe('getRunLogPathForRoot', () => {
    beforeEach(() => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
    });

    test('composes a transcript path from a persisted project root', () => {
      const root = join('/custom/archon', 'workspaces', 'acme', 'widget');
      expect(getRunLogPathForRoot(root, 'run-1')).toBe(join(root, 'logs', 'run-1.jsonl'));
    });

    test('agrees with the repo-specific helper', () => {
      const root = join('/custom/archon', 'workspaces', 'acme', 'widget');
      expect(getRunLogPath('acme', 'widget', 'run-1')).toBe(getRunLogPathForRoot(root, 'run-1'));
    });
  });

  describe('getRunWorkflowSourceDirForRoot', () => {
    beforeEach(() => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
    });

    test('composes a run source path beside, not inside, the run artifacts', () => {
      const root = join('/custom/archon', 'workspaces', 'acme', 'widget');
      const source = getRunWorkflowSourceDirForRoot(root, 'run-1');
      expect(source).toBe(join(root, 'workflow-source', 'runs', 'run-1'));
      // The failure this guards: a capture placed under `$ARTIFACTS_DIR` is handed to
      // every node by path and listed as the run's output.
      expect(source.startsWith(getRunArtifactsDirForRoot(root, 'run-1') + sep)).toBe(false);
      expect(getStoragePathsForRoot(root).workflowSourceRoot).toBe(join(root, 'workflow-source'));
    });
  });

  describe('getRunArtifactsPath', () => {
    test('returns artifacts/runs/{id}/ path', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getRunArtifactsPath('acme', 'widget', 'run-123')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'artifacts', 'runs', 'run-123')
      );
    });
  });

  describe('getRunLogPath', () => {
    test('returns logs/{id}.jsonl path', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getRunLogPath('acme', 'widget', 'run-123')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'logs', 'run-123.jsonl')
      );
    });
  });

  describe('getScopeArtifactsPath', () => {
    test('returns scopes/<workflow>/<scope>/ under the given artifacts root', () => {
      expect(getScopeArtifactsPath('/root/artifacts', 'feature-dev', 'conv-uuid-1')).toBe(
        join('/root/artifacts', 'scopes', 'feature-dev', 'conv-uuid-1')
      );
    });

    test('sanitizes workflow name and scope key segments', () => {
      expect(getScopeArtifactsPath('/root/artifacts', 'wf/../evil', 'a b#c')).toBe(
        join('/root/artifacts', 'scopes', 'wf____evil', 'a_b_c')
      );
    });

    test('composes with run-artifact roots (sibling of runs/)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const root = getProjectArtifactsPath('acme', 'widget');
      expect(getScopeArtifactsPath(root, 'wf', 'scope')).toBe(
        join(
          homedir(),
          '.archon',
          'workspaces',
          'acme',
          'widget',
          'artifacts',
          'scopes',
          'wf',
          'scope'
        )
      );
    });
  });
});
