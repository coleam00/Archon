import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join, posix, sep, win32 } from 'path';
import { existsSync, readFileSync } from 'fs';
import { lstat } from 'fs/promises';
import {
  expandTilde,
  isDocker,
  isWSL,
  getWSLDistroName,
  getArchonHome,
  getArchonWorkspacesPath,
  isPathInside,
  isInsideArchonWorkspaces,
  ensureArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonTempPath,
  getArchonConfigPath,
  getInstallManifestPath,
  getCredentialKeyPath,
  getHomeWorkflowsPath,
  getHomeCommandsPath,
  getHomeScriptsPath,
  isInsideArchonHome,
  logArchonPaths,
} from './home-paths';
import { usePathEnvSnapshot, removeTempTree } from './test-utils';

describe('home-paths', () => {
  usePathEnvSnapshot();

  describe('expandTilde', () => {
    test('expands ~ to home directory', () => {
      expect(expandTilde('~/test')).toBe(join(homedir(), 'test'));
    });

    test('returns path unchanged if no tilde', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('isWSL', () => {
    test('returns true when WSL_DISTRO_NAME is set', () => {
      process.env.WSL_DISTRO_NAME = 'Ubuntu';
      expect(isWSL()).toBe(true);
    });

    test('falls back to /proc/sys/kernel/osrelease when WSL_DISTRO_NAME is unset', () => {
      delete process.env.WSL_DISTRO_NAME;
      // Derive the expectation from the same source as the implementation:
      // real Linux CI → no "microsoft" → false; WSL2 host → "microsoft" → true.
      let expected = false;
      try {
        expected = readFileSync('/proc/sys/kernel/osrelease', 'utf8')
          .toLowerCase()
          .includes('microsoft');
      } catch {
        expected = false;
      }
      expect(isWSL()).toBe(expected);
    });
  });

  describe('getWSLDistroName', () => {
    test('returns the WSL_DISTRO_NAME env var when set', () => {
      process.env.WSL_DISTRO_NAME = 'Debian';
      expect(getWSLDistroName()).toBe('Debian');
    });

    test('returns undefined when WSL_DISTRO_NAME is unset', () => {
      delete process.env.WSL_DISTRO_NAME;
      expect(getWSLDistroName()).toBeUndefined();
    });

    test('returns the empty string when WSL_DISTRO_NAME is set but empty', () => {
      // Pins current behaviour: '' passes through (callers filter falsy values),
      // so a future `|| undefined` refactor would change observable behaviour.
      process.env.WSL_DISTRO_NAME = '';
      expect(getWSLDistroName()).toBe('');
    });
  });

  describe('isDocker', () => {
    test('returns true when WORKSPACE_PATH is /workspace', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when HOME=/root and WORKSPACE_PATH set', () => {
      process.env.HOME = '/root';
      process.env.WORKSPACE_PATH = '/app/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when ARCHON_DOCKER=true', () => {
      delete process.env.WORKSPACE_PATH;
      process.env.ARCHON_DOCKER = 'true';
      expect(isDocker()).toBe(true);
    });

    test('returns false for local development', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.HOME = homedir();
      expect(isDocker()).toBe(false);
    });
  });

  describe('getArchonHome', () => {
    test('returns /.archon in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(getArchonHome()).toBe('/.archon');
    });

    test('returns ARCHON_HOME when set (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonHome()).toBe('/custom/archon');
    });

    test('expands tilde in ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '~/my-archon';
      expect(getArchonHome()).toBe(join(homedir(), 'my-archon'));
    });

    test('returns ~/.archon by default (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonHome()).toBe(join(homedir(), '.archon'));
    });
  });

  describe('getArchonWorkspacesPath', () => {
    test('returns ~/.archon/workspaces by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorkspacesPath()).toBe(join(homedir(), '.archon', 'workspaces'));
    });

    test('returns /.archon/workspaces in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getArchonWorkspacesPath()).toBe(join('/', '.archon', 'workspaces'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonWorkspacesPath()).toBe(join('/custom/archon', 'workspaces'));
    });
  });

  describe('getArchonWorktreesPath', () => {
    test('returns ~/.archon/worktrees by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorktreesPath()).toBe(join(homedir(), '.archon', 'worktrees'));
    });

    test('returns /.archon/worktrees in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getArchonWorktreesPath()).toBe(join('/', '.archon', 'worktrees'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonWorktreesPath()).toBe(join('/custom/archon', 'worktrees'));
    });
  });

  describe('getInstallManifestPath', () => {
    test('returns install.json under the default ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getInstallManifestPath()).toBe(join(homedir(), '.archon', 'install.json'));
    });

    test('respects ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getInstallManifestPath()).toBe(join('/custom/archon', 'install.json'));
    });
  });

  describe('getArchonTempPath', () => {
    test('returns ~/.archon/temp by default', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonTempPath()).toBe(join(homedir(), '.archon', 'temp'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonTempPath()).toBe(join('/custom/archon', 'temp'));
    });
  });

  describe('getArchonConfigPath', () => {
    test('returns path to config.yaml', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonConfigPath()).toBe(join(homedir(), '.archon', 'config.yaml'));
    });
  });

  describe('getCredentialKeyPath', () => {
    test('returns credential-key inside ARCHON_HOME', () => {
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getCredentialKeyPath()).toBe(join('/custom/archon', 'credential-key'));
    });
  });

  describe('getHomeWorkflowsPath', () => {
    test('returns ~/.archon/workflows by default (direct child of ~/.archon/)', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeWorkflowsPath()).toBe(join(homedir(), '.archon', 'workflows'));
    });

    test('returns /.archon/workflows in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getHomeWorkflowsPath()).toBe(join('/', '.archon', 'workflows'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getHomeWorkflowsPath()).toBe(join('/custom/archon', 'workflows'));
    });

    test('no double `.archon/` nesting — must sit next to workspaces/ and worktrees/', () => {
      // Regression guard: the old location was ~/.archon/.archon/workflows/.
      // New location must NOT reintroduce the double-nested path.
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeWorkflowsPath()).not.toContain(join('.archon', '.archon'));
    });
  });

  describe('getHomeCommandsPath', () => {
    test('returns ~/.archon/commands by default', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeCommandsPath()).toBe(join(homedir(), '.archon', 'commands'));
    });

    test('returns /.archon/commands in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getHomeCommandsPath()).toBe(join('/', '.archon', 'commands'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getHomeCommandsPath()).toBe(join('/custom/archon', 'commands'));
    });
  });

  describe('getHomeScriptsPath', () => {
    test('returns ~/.archon/scripts by default', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeScriptsPath()).toBe(join(homedir(), '.archon', 'scripts'));
    });

    test('returns /.archon/scripts in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getHomeScriptsPath()).toBe(join('/', '.archon', 'scripts'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getHomeScriptsPath()).toBe(join('/custom/archon', 'scripts'));
    });
  });

  describe('isPathInside', () => {
    test('POSIX: a descendant is inside; the root itself, a sibling, and a lookalike are not', () => {
      const root = '/home/me/.archon/workspaces';
      expect(
        isPathInside(root, '/home/me/.archon/workspaces/owner/repo/source', { pathApi: posix })
      ).toBe(true);
      expect(
        isPathInside(root, '/home/me/.archon/workspaces/../workspaces/o/r', { pathApi: posix })
      ).toBe(true);
      expect(isPathInside(root, '/home/me/.archon/workspaces/..hidden', { pathApi: posix })).toBe(
        true
      );
      expect(isPathInside(root, root, { pathApi: posix })).toBe(false);
      expect(isPathInside(root, `${root}/`, { pathApi: posix })).toBe(false);
      expect(isPathInside(root, '/home/me/.archon/workspaces-old/o/r', { pathApi: posix })).toBe(
        false
      );
      expect(
        isPathInside(root, '/mnt/backup/.archon/workspaces/o/r/source', { pathApi: posix })
      ).toBe(false);
      expect(
        isPathInside(root, '/home/me/.archon/workspaces/../elsewhere', { pathApi: posix })
      ).toBe(false);
    });

    test('Windows: either separator and any case match; another drive or a lookalike does not', () => {
      const root = 'C:\\Users\\me\\.archon\\workspaces';
      const inside = [
        'C:\\Users\\me\\.archon\\workspaces\\owner\\repo\\source',
        'C:/Users/me/.archon/workspaces/owner/repo/source',
        'c:\\users\\ME\\.Archon\\Workspaces\\owner\\repo',
      ];
      for (const candidate of inside)
        expect(isPathInside(root, candidate, { pathApi: win32 })).toBe(true);
      expect(isPathInside('C:/Users/me/.archon/workspaces', inside[0], { pathApi: win32 })).toBe(
        true
      );

      const outside = [
        root,
        'C:\\Users\\me\\.archon\\workspaces-old\\o\\r',
        'D:\\Users\\me\\.archon\\workspaces\\o\\r',
        'C:\\backup\\.archon\\workspaces\\o\\r\\source',
        'C:\\Users\\me\\.archon\\workspaces\\..\\elsewhere',
      ];
      for (const candidate of outside)
        expect(isPathInside(root, candidate, { pathApi: win32 })).toBe(false);
    });

    test('includeRoot counts the root itself, with or without a trailing separator', () => {
      const root = '/home/me/.archon';
      expect(isPathInside(root, root, { includeRoot: true, pathApi: posix })).toBe(true);
      expect(isPathInside(root, `${root}/`, { includeRoot: true, pathApi: posix })).toBe(true);
      expect(
        isPathInside(root, '/home/me/.archon-old', { includeRoot: true, pathApi: posix })
      ).toBe(false);
    });

    test('lexical POSIX: never resolves against the cwd, and keeps the separator boundary', () => {
      const opts = { includeRoot: true, lexical: true, pathApi: posix };
      const root = '/home/me/.archon';
      expect(isPathInside(root, root, opts)).toBe(true);
      expect(isPathInside(root, `${root}/`, opts)).toBe(true);
      expect(isPathInside(root, '/home/me/.archon/runs/r1', opts)).toBe(true);
      expect(isPathInside(`${root}/`, '/home/me/.archon/runs/r1', opts)).toBe(true);
      expect(isPathInside('/', '/etc', opts)).toBe(true);

      expect(isPathInside(root, '/home/me/.archon-old/runs', opts)).toBe(false);
      expect(isPathInside(root, '/home/me/.archon/../other', opts)).toBe(false);
      expect(isPathInside(root, '/home/me/.archon/runs/../../other', opts)).toBe(false);
      expect(isPathInside(root, '/home/me/.ARCHON/runs', opts)).toBe(false);
      // A relative path is never inside an absolute root, even when the cwd is the root.
      expect(isPathInside(process.cwd(), 'runs/r1', { ...opts, pathApi: undefined })).toBe(false);
      expect(isPathInside(root, '', opts)).toBe(false);

      const strict = { lexical: true, pathApi: posix };
      expect(isPathInside(root, root, strict)).toBe(false);
      expect(isPathInside(root, `${root}/`, strict)).toBe(false);
      expect(isPathInside(root, '/home/me/.archon/x', strict)).toBe(true);
    });

    test('lexical Windows: either separator matches, but a case variant or another drive does not', () => {
      const opts = { includeRoot: true, lexical: true, pathApi: win32 };
      const root = 'C:\\Users\\me\\.archon';
      expect(isPathInside(root, 'C:\\Users\\me\\.archon\\runs\\r1', opts)).toBe(true);
      expect(isPathInside(root, 'C:/Users/me/.archon/runs/r1', opts)).toBe(true);
      expect(isPathInside(root, 'C:\\Users\\me\\.archon\\', opts)).toBe(true);
      expect(isPathInside('C:\\', 'C:\\Users', opts)).toBe(true);

      expect(isPathInside(root, 'c:\\users\\ME\\.archon\\runs', opts)).toBe(false);
      expect(isPathInside(root, 'C:\\Users\\me\\.archon-old\\runs', opts)).toBe(false);
      expect(isPathInside(root, 'C:\\Users\\me\\.archon\\..\\other', opts)).toBe(false);
      expect(isPathInside(root, 'D:\\Users\\me\\.archon\\runs', opts)).toBe(false);
      expect(isPathInside(root, '.archon\\runs', opts)).toBe(false);
    });
  });

  describe('isInsideArchonHome', () => {
    test('accepts the home and its descendants; rejects lookalikes, traversal, and relative paths', () => {
      delete process.env.ARCHON_DOCKER;
      const home = join(tmpdir(), 'archon-home-inside');
      process.env.ARCHON_HOME = home;
      expect(isInsideArchonHome(home)).toBe(true);
      expect(isInsideArchonHome(join(home, 'workspaces', 'o', 'r'))).toBe(true);
      expect(isInsideArchonHome(`${home}${sep}`)).toBe(true);

      expect(isInsideArchonHome(`${home}-old${sep}workspaces`)).toBe(false);
      expect(isInsideArchonHome(`${home}${sep}..${sep}elsewhere`)).toBe(false);
      expect(isInsideArchonHome(join('workspaces', 'o', 'r'))).toBe(false);
      expect(isInsideArchonHome('')).toBe(false);
    });
  });

  describe('isInsideArchonWorkspaces', () => {
    test('answers against the configured workspaces root, not a path fragment', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = join(tmpdir(), 'custom-home', '.archon');
      const workspaces = getArchonWorkspacesPath();
      expect(isInsideArchonWorkspaces(join(workspaces, 'owner', 'repo', 'source'))).toBe(true);
      expect(isInsideArchonWorkspaces(workspaces)).toBe(false);
      // The default ~/.archon/workspaces is not this host's root once ARCHON_HOME moves it.
      expect(isInsideArchonWorkspaces(join(homedir(), '.archon', 'workspaces', 'o', 'r'))).toBe(
        false
      );
    });
  });
});

describe('logArchonPaths', () => {
  usePathEnvSnapshot();

  test('does not throw', () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_HOME;
    delete process.env.ARCHON_DOCKER;
    expect(() => logArchonPaths()).not.toThrow();
  });
});

describe('ensureArchonWorkspacesPath', () => {
  let tempArchonHome: string;
  usePathEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    tempArchonHome = join(
      tmpdir(),
      `archon-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = tempArchonHome;
  });

  afterEach(async () => {
    await removeTempTree(tempArchonHome);
  });

  test('creates the workspaces directory when missing', async () => {
    const expected = getArchonWorkspacesPath();
    expect(existsSync(expected)).toBe(false);

    const returned = await ensureArchonWorkspacesPath();

    expect(returned).toBe(expected);
    expect((await lstat(expected)).isDirectory()).toBe(true);
  });

  test('is idempotent - safe to call twice', async () => {
    await ensureArchonWorkspacesPath();
    await ensureArchonWorkspacesPath();

    const expected = getArchonWorkspacesPath();
    expect((await lstat(expected)).isDirectory()).toBe(true);
  });
});
