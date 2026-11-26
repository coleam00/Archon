import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  assertRunForgeAccess,
  ForgeRequirementError,
  forgeCheckFailure,
  type ForgeCheck,
  type RunForgeAccessSite,
} from './run-forge-access';
import type { WorkflowPackMember } from './schemas/pack-settings';

const trackTempRoot = trackTempRoots();

function checkout(remotes: Record<string, string>): string {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-access-')));
  Bun.spawnSync(['git', 'init', '-q', dir]);
  for (const [name, url] of Object.entries(remotes)) {
    Bun.spawnSync(['git', '-C', dir, 'remote', 'add', name, url]);
  }
  return dir;
}

const noGithub = { store: { getCodebase: async () => null } };

const declaring: { name: string; pack: WorkflowPackMember } = {
  name: 'deliver',
  pack: {
    key: 'factory',
    workflow: 'deliver',
    source: 'project',
    forge: { operations: ['pr.view'] },
  },
};
const prepared = { config: { envVars: {} }, executionUserId: undefined };

function site(
  cwd: string,
  inContainer = false,
  supplied?: RunForgeAccessSite['supplied']
): RunForgeAccessSite {
  return { cwd, settingsCwd: cwd, codebaseId: undefined, inContainer, supplied };
}

/** The common call: a declaring pack, freshly prepared, on the host. */
function assertFor(cwd: string, check: ForgeCheck): ReturnType<typeof assertRunForgeAccess> {
  return assertRunForgeAccess(noGithub, declaring, prepared, site(cwd), check);
}

async function refusal(
  run: Promise<unknown>
): Promise<ForgeRequirementError['failures'] | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    if (!(error instanceof ForgeRequirementError)) throw error;
    return error.failures;
  }
}

let savedCliCommand: string | undefined;
beforeEach(() => {
  savedCliCommand = process.env.ARCHON_CLI_COMMAND;
  process.env.ARCHON_CLI_COMMAND = JSON.stringify(['archon']);
});
afterEach(() => {
  if (savedCliCommand === undefined) delete process.env.ARCHON_CLI_COMMAND;
  else process.env.ARCHON_CLI_COMMAND = savedCliCommand;
});

describe('assertRunForgeAccess', () => {
  test('a pack that declares no forge needs is never checked', async () => {
    const check = mock<ForgeCheck>(async () => undefined);
    const noForge = { name: 'w', pack: { key: 'p', workflow: 'w', source: 'project' } } as const;
    await assertRunForgeAccess(noGithub, noForge, prepared, site('/nonexistent'), check);
    await assertRunForgeAccess(noGithub, { name: 'w' }, prepared, site('/nonexistent'), check);
    expect(check).not.toHaveBeenCalled();
  });

  test('a container execution is refused without asking the forge', async () => {
    const check = mock<ForgeCheck>(async () => undefined);
    const failures = await refusal(
      assertRunForgeAccess(noGithub, declaring, prepared, site('/nonexistent', true), check)
    );
    expect(failures).toEqual([expect.objectContaining({ reason: 'no_forge_path' })]);
    expect(check).not.toHaveBeenCalled();
  });

  test('a checkout with no remote, or a project that is not a git repository, is refused', async () => {
    const plainFolder = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-access-')));
    expect(await refusal(assertFor(checkout({}), async () => undefined))).toEqual([
      expect.objectContaining({
        reason: 'no_forge_remote',
        message: 'the checkout has no git remote',
      }),
    ]);
    expect(await refusal(assertFor(plainFolder, async () => undefined))).toEqual([
      expect.objectContaining({
        reason: 'no_forge_remote',
        message: 'the project is not a git repository',
      }),
    ]);
  });

  test('each remote is asked for the declared capabilities, and one that serves the run is enough', async () => {
    const check = mock<ForgeCheck>(async request =>
      'remote' in request && request.remote.includes('mirror')
        ? { reason: 'no_plugin_for_host', message: 'no forge plugin claims mirror.example' }
        : undefined
    );
    await assertFor(
      checkout({ mirror: 'https://mirror.example/o/r.git', origin: 'git@github.com:o/r.git' }),
      check
    );
    expect(check.mock.calls.map(([request]) => request)).toEqual([
      { remote: 'https://mirror.example/o/r.git', operations: ['pr.view'] },
      { remote: 'git@github.com:o/r.git', operations: ['pr.view'] },
    ]);
  });

  test('a remote configured through an included git config file is asked like any other', async () => {
    const dir = checkout({});
    const included = join(dir, 'remotes.cfg');
    Bun.spawnSync(['git', 'config', '-f', included, 'remote.origin.url', 'git@github.com:o/r.git']);
    Bun.spawnSync(['git', '-C', dir, 'config', 'include.path', included]);
    const check = mock<ForgeCheck>(async () => undefined);
    await assertFor(dir, check);
    expect(check.mock.calls.map(([request]) => request)).toEqual([
      { remote: 'git@github.com:o/r.git', operations: ['pr.view'] },
    ]);
  });

  test('a remote is asked by the URL git fetches, after its insteadOf rewrite', async () => {
    const dir = checkout({ origin: 'gh:o/r.git' });
    Bun.spawnSync(['git', '-C', dir, 'config', 'url.git@github.com:.insteadOf', 'gh:']);
    const check = mock<ForgeCheck>(async () => undefined);
    await assertFor(dir, check);
    expect(check.mock.calls.map(([request]) => request)).toEqual([
      { remote: 'git@github.com:o/r.git', operations: ['pr.view'] },
    ]);
  });

  test('a refusal names each remote with its typed reason and remedy, never its URL', async () => {
    const failures = await refusal(
      assertFor(checkout({ origin: 'https://user:secret@github.com/o/r.git' }), async () => ({
        reason: 'unsupported_op',
        message: 'plugin github 1 does not support resolve:subject',
        unsupported: ['resolve:subject'],
        remedy: 'archon plugin update',
      }))
    );
    expect(failures).toEqual([
      {
        remote: 'origin',
        reason: 'unsupported_op',
        message: 'plugin github 1 does not support resolve:subject',
        unsupported: ['resolve:subject'],
        remedy: 'archon plugin update',
      },
    ]);
    const error = await assertFor(
      checkout({ origin: 'https://user:secret@github.com/o/r.git' }),
      async () => ({ reason: 'no_credential', message: 'GH_TOKEN is not set' })
    ).catch((caught: unknown) => caught as Error);
    expect(error?.message).toContain("Remote 'origin': GH_TOKEN is not set (no_credential).");
    expect(error?.message).not.toContain('secret');
  });

  test("the check sees the run's per-user GitHub token, as the run's forge calls do", async () => {
    const check = mock<ForgeCheck>(async () => undefined);
    await assertRunForgeAccess(
      {
        ...noGithub,
        isPerUserGitHubEnabled: () => true,
        getUserGithubToken: async () => 'user-token',
      },
      declaring,
      { ...prepared, executionUserId: 'u1' },
      site(checkout({ origin: 'git@github.com:o/r.git' })),
      check
    );
    expect(check.mock.calls[0]?.[1].env.GH_TOKEN).toBe('user-token');
  });

  describe('a pack that names its repository by inputs', () => {
    const naming: { name: string; pack: WorkflowPackMember } = {
      name: 'merge-queue',
      pack: {
        ...declaring.pack,
        forge: { operations: ['pr.view'], repository: { host: 'repo_host', path: 'repo_path' } },
      },
    };
    const capableMirror = () => checkout({ mirror: 'git@github.com:mirror/r.git' });
    const run = (supplied: RunForgeAccessSite['supplied'], check: ForgeCheck) =>
      assertRunForgeAccess(
        noGithub,
        naming,
        prepared,
        site(capableMirror(), false, supplied),
        check
      );

    test('is checked against that repository alone, so a capable remote cannot start it', async () => {
      const check = mock<ForgeCheck>(async request =>
        'repo' in request ? { reason: 'not_found', message: 'Not Found' } : undefined
      );
      const error = await run({ repo_host: 'github.com', repo_path: 'o/target' }, check).catch(
        (caught: unknown) => caught as ForgeRequirementError
      );
      expect(error).toBeInstanceOf(ForgeRequirementError);
      expect(error?.failures).toEqual([{ reason: 'not_found', message: 'Not Found' }]);
      expect(error?.message).toContain("Repository 'github.com/o/target'");
      expect(check.mock.calls.map(([request]) => request)).toEqual([
        { repo: { host: 'github.com', path: 'o/target' }, operations: ['pr.view'] },
      ]);
    });

    test('falls back to the checkout remotes when neither input is set', async () => {
      const check = mock<ForgeCheck>(async () => undefined);
      // The run starts with its own inputs: nothing names a repository to pin.
      expect(await run({ repo_host: '', repo_path: ' ' }, check)).toEqual({
        repo_host: '',
        repo_path: ' ',
      });
      await run(undefined, check);
      expect(check.mock.calls.map(([request]) => request)).toEqual([
        { remote: 'git@github.com:mirror/r.git', operations: ['pr.view'] },
        { remote: 'git@github.com:mirror/r.git', operations: ['pr.view'] },
      ]);
    });

    const settingNaming = {
      ...naming,
      pack: {
        ...naming.pack,
        settings: { repo_host: { type: 'string' }, repo_path: { type: 'string' } },
      },
    } as const;
    function namingSettings(cwd: string, repoPath: string): string {
      mkdirSync(join(cwd, '.archon', 'packs'), { recursive: true });
      writeFileSync(
        join(cwd, '.archon', 'packs', 'factory.yaml'),
        `settings:\n  repo_host: github.com\n  repo_path: ${repoPath}\n`
      );
      return cwd;
    }

    test('reads the repository from the project settings when the run supplies none', async () => {
      const check = mock<ForgeCheck>(async () => undefined);
      const judged = await assertRunForgeAccess(
        noGithub,
        settingNaming,
        prepared,
        site(namingSettings(capableMirror(), 'o/target'), false, { goal: 'ship' }),
        check
      );
      expect(check.mock.calls.map(([request]) => request)).toEqual([
        { repo: { host: 'github.com', path: 'o/target' }, operations: ['pr.view'] },
      ]);
      // The run starts with these, so a worktree cut later cannot name another repository.
      expect(judged).toEqual({ goal: 'ship', repo_host: 'github.com', repo_path: 'o/target' });
    });

    test('reads the settings of the checkout the run starts in, not the project checkout', async () => {
      const project = namingSettings(capableMirror(), 'o/project');
      const adoptedWorktree = namingSettings(
        trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-access-'))),
        'o/worktree'
      );
      const check = mock<ForgeCheck>(async () => undefined);
      await assertRunForgeAccess(
        noGithub,
        settingNaming,
        prepared,
        { ...site(project), settingsCwd: adoptedWorktree },
        check
      );
      expect(check.mock.calls.map(([request]) => request)).toEqual([
        { repo: { host: 'github.com', path: 'o/worktree' }, operations: ['pr.view'] },
      ]);
    });

    test('does not check file settings: the run checks them in the checkout it opens them in', async () => {
      const filed = {
        ...settingNaming,
        pack: {
          ...settingNaming.pack,
          settings: { ...settingNaming.pack.settings, policy: { type: 'string', file: true } },
        },
      } as const;
      const cwd = capableMirror();
      mkdirSync(join(cwd, '.archon', 'packs'), { recursive: true });
      writeFileSync(
        join(cwd, '.archon', 'packs', 'factory.yaml'),
        'settings:\n  repo_host: github.com\n  repo_path: o/target\n  policy: docs/missing.md\n'
      );
      const check = mock<ForgeCheck>(async () => undefined);
      await assertRunForgeAccess(noGithub, filed, prepared, site(cwd), check);
      expect(check.mock.calls.map(([request]) => request)).toEqual([
        { repo: { host: 'github.com', path: 'o/target' }, operations: ['pr.view'] },
      ]);
    });

    test('is refused without a check when only one input is set', async () => {
      const check = mock<ForgeCheck>(async () => undefined);
      const failures = await refusal(run({ repo_host: '', repo_path: 'o/target' }, check));
      expect(failures).toEqual([expect.objectContaining({ reason: 'no_forge_repository' })]);
      expect(check).not.toHaveBeenCalled();
    });
  });

  test('a host with no CLI command for the forge is refused', async () => {
    delete process.env.ARCHON_CLI_COMMAND;
    const failures = await refusal(
      assertFor(checkout({ origin: 'git@github.com:o/r.git' }), async () => undefined)
    );
    expect(failures).toEqual([expect.objectContaining({ reason: 'no_forge_path' })]);
  });
});

describe('forgeCheckFailure', () => {
  const answer = (value: object): string => JSON.stringify({ operationId: 'op', ...value });
  const exited = (exitCode: number) => ({ exitCode, signalCode: null });
  const request = { remote: 'git@github.com:o/r.git', operations: ['pr.view'] };

  test('a passing answer lets the run start', () => {
    expect(
      forgeCheckFailure(
        answer({
          ok: true,
          result: {
            op: 'check',
            value: {
              host: 'github.com',
              plugin: { name: 'github', version: '1' },
              operations: [],
            },
          },
        }),
        exited(0),
        request
      )
    ).toBeUndefined();
  });

  test.each([
    'no_plugin_for_host',
    'unsupported_op',
    'no_credential',
    'authorization',
    'not_found',
  ] as const)('the forge refusal %s keeps its kind and remedy', kind => {
    expect(
      forgeCheckFailure(
        answer({ ok: false, error: { kind, message: 'm' }, remedy: 'do this' }),
        exited(1),
        request
      )
    ).toEqual({ reason: kind, message: 'm', remedy: 'do this' });
  });

  test('any other failure, or no answer at all, is a check that failed', () => {
    expect(
      forgeCheckFailure(
        answer({ ok: false, error: { kind: 'process_failed', message: 'discovery failed' } }),
        exited(1),
        request
      )
    ).toEqual({ reason: 'check_failed', message: 'discovery failed' });
  });

  test('a check with no answer names how it ended and how to rerun it, never its output', () => {
    const stopped = forgeCheckFailure('', { exitCode: null, signalCode: 'SIGTERM' }, request);
    expect(stopped).toMatchObject({ reason: 'check_failed' });
    expect(stopped?.message).toContain('SIGTERM');
    expect(forgeCheckFailure('', exited(3), request)).toMatchObject({ reason: 'check_failed' });
    const garbled = forgeCheckFailure('token=ghp_secret not json', exited(3), request);
    expect(garbled?.message).toContain('3');
    expect(JSON.stringify(garbled)).not.toContain('ghp_secret');
    expect(garbled).toMatchObject({ reason: 'check_failed' });
    expect(garbled?.remedy).toContain('--data-file');
    expect(garbled?.remedy).toContain('pr.view');
    expect(garbled?.remedy).not.toContain('o/r.git');
  });
});
