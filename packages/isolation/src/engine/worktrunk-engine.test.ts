import { describe, test, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';

// Mock @archon/paths so nothing in this file touches the real filesystem/home dir.
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
}));

import * as git from '@archon/git';
import { toRepoPath, toBranchName, toWorktreePath } from '@archon/git';
import { WorktrunkEngine, MIN_WORKTRUNK_VERSION } from './worktrunk-engine';

describe('WorktrunkEngine', () => {
  let engine: WorktrunkEngine;
  let execSpy: Mock<typeof git.execFileAsync>;

  /** Route `wt --version` to a fixed success response; other calls fall through to whatever's queued. */
  function mockVersion(version = MIN_WORKTRUNK_VERSION): void {
    execSpy.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'wt' && args[0] === '--version') {
        return { stdout: `wt ${version}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
  }

  beforeEach(() => {
    engine = new WorktrunkEngine();
    execSpy = spyOn(git, 'execFileAsync');
    mockVersion();
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  test('id is worktrunk', () => {
    expect(engine.id).toBe('worktrunk');
  });

  describe('binary preflight', () => {
    test('missing binary fails with an actionable error naming wt', async () => {
      execSpy.mockImplementation(async (cmd: string) => {
        if (cmd === 'wt') {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          throw err;
        }
        return { stdout: '', stderr: '' };
      });

      await expect(engine.list(toRepoPath('/repo'))).rejects.toThrow(
        /'wt' binary was not found on PATH/
      );
    });

    test('too-old version fails with an actionable error naming the minimum version', async () => {
      mockVersion('0.10.0');

      await expect(engine.list(toRepoPath('/repo'))).rejects.toThrow(
        new RegExp(
          `older than the minimum supported ${MIN_WORKTRUNK_VERSION.replace(/\./g, '\\.')}`
        )
      );
    });

    test('unparsable version output fails loudly', async () => {
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          return { stdout: 'garbage output\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(engine.list(toRepoPath('/repo'))).rejects.toThrow(/older than the minimum/);
    });

    test('a successful probe is cached across calls (only one --version invocation)', async () => {
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          return { stdout: `wt ${MIN_WORKTRUNK_VERSION}\n`, stderr: '' };
        }
        return { stdout: '[]', stderr: '' };
      });

      await engine.list(toRepoPath('/repo'));
      await engine.list(toRepoPath('/repo'));

      const versionCalls = execSpy.mock.calls.filter(
        call => call[0] === 'wt' && (call[1] as string[])[0] === '--version'
      );
      expect(versionCalls.length).toBe(1);
    });

    test('a failed probe is not cached, so a later retry re-probes', async () => {
      let calls = 0;
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          calls++;
          if (calls === 1) {
            const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            throw err;
          }
          return { stdout: `wt ${MIN_WORKTRUNK_VERSION}\n`, stderr: '' };
        }
        return { stdout: '[]', stderr: '' };
      });

      await expect(engine.list(toRepoPath('/repo'))).rejects.toThrow();
      await expect(engine.list(toRepoPath('/repo'))).resolves.toEqual([]);
      expect(calls).toBe(2);
    });
  });

  describe('add', () => {
    test('new branch: wt switch --create <branch> --base <startPoint>, pinned path', async () => {
      await engine.add({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt/archon-task-x'),
        branch: toBranchName('archon/task-x'),
        startPoint: 'origin/main',
      });

      const addCall = execSpy.mock.calls.find(
        call => call[0] === 'wt' && (call[1] as string[])[0] === 'switch'
      );
      expect(addCall).toBeDefined();
      const args = addCall![1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          'switch',
          '--create',
          'archon/task-x',
          '--base',
          'origin/main',
          '--no-cd',
          '--yes',
          '-C',
          '/repo',
        ])
      );
      const configSetIndex = args.indexOf('--config-set');
      expect(configSetIndex).toBeGreaterThan(-1);
      expect(args[configSetIndex + 1]).toBe(
        `worktree-path=${JSON.stringify('/repo/wt/archon-task-x')}`
      );
    });

    test('no start point: wt switch <branch> (existing local branch)', async () => {
      await engine.add({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt/existing'),
        branch: toBranchName('existing-branch'),
      });

      const addCall = execSpy.mock.calls.find(
        call => call[0] === 'wt' && (call[1] as string[])[0] === 'switch'
      );
      const args = addCall![1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['switch', 'existing-branch', '--no-cd', '--yes', '-C', '/repo'])
      );
      expect(args).not.toContain('--create');
    });

    test('propagates subprocess errors unchanged', async () => {
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          return { stdout: `wt ${MIN_WORKTRUNK_VERSION}\n`, stderr: '' };
        }
        throw Object.assign(new Error('Branch already exists'), {
          stderr: '✗ Branch already exists',
        });
      });

      await expect(
        engine.add({
          repoPath: toRepoPath('/repo'),
          worktreePath: toWorktreePath('/repo/wt'),
          branch: toBranchName('archon/task-x'),
          startPoint: 'origin/main',
        })
      ).rejects.toThrow('Branch already exists');
    });
  });

  describe('remove', () => {
    test('always passes --no-delete-branch and --foreground (branch lifecycle stays with the provider)', async () => {
      await engine.remove({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
      });

      const removeCall = execSpy.mock.calls.find(
        call => call[0] === 'wt' && (call[1] as string[])[0] === 'remove'
      );
      const args = removeCall![1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          'remove',
          '/repo/wt',
          '--foreground',
          '--no-delete-branch',
          '--yes',
          '-C',
          '/repo',
        ])
      );
      expect(args).not.toContain('--force');
    });

    test('force: true adds --force', async () => {
      await engine.remove({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
        force: true,
      });

      const removeCall = execSpy.mock.calls.find(
        call => call[0] === 'wt' && (call[1] as string[])[0] === 'remove'
      );
      expect(removeCall![1] as string[]).toContain('--force');
    });
  });

  describe('list', () => {
    test('parses wt list --format json, keeping only worktree rows with a branch', async () => {
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          return { stdout: `wt ${MIN_WORKTRUNK_VERSION}\n`, stderr: '' };
        }
        return {
          stdout: JSON.stringify([
            { branch: 'main', path: '/repo', kind: 'worktree' },
            { branch: 'feature-x', path: '/repo/wt/feature-x', kind: 'worktree' },
            { branch: 'branch-only-no-worktree', path: null, kind: 'branch' },
          ]),
          stderr: '',
        };
      });

      const result = await engine.list(toRepoPath('/repo'));
      expect(result).toEqual([
        { path: '/repo', branch: 'main' },
        { path: '/repo/wt/feature-x', branch: 'feature-x' },
      ]);
    });

    test('throws on malformed JSON', async () => {
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          return { stdout: `wt ${MIN_WORKTRUNK_VERSION}\n`, stderr: '' };
        }
        return { stdout: 'not json', stderr: '' };
      });

      await expect(engine.list(toRepoPath('/repo'))).rejects.toThrow(/Failed to parse/);
    });

    test('throws when the top-level value is not an array', async () => {
      execSpy.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'wt' && args[0] === '--version') {
          return { stdout: `wt ${MIN_WORKTRUNK_VERSION}\n`, stderr: '' };
        }
        return { stdout: JSON.stringify({ not: 'an array' }), stderr: '' };
      });

      await expect(engine.list(toRepoPath('/repo'))).rejects.toThrow(/expected an array/);
    });
  });

  describe('prune', () => {
    test('uses raw git worktree prune, not a wt command', async () => {
      await engine.prune(toRepoPath('/repo'));

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/repo', 'worktree', 'prune'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      const wtCalls = execSpy.mock.calls.filter(call => call[0] === 'wt');
      expect(wtCalls.length).toBe(0);
    });
  });
});
