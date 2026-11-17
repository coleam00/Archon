import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'fs';
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
import type { WorkflowPack } from './schemas/pack-settings';

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

const declaring: { name: string; pack: WorkflowPack } = {
  name: 'deliver',
  pack: { key: 'factory', source: 'project', forge: { operations: ['pr.view'] } },
};
const prepared = { config: { envVars: {} }, executionUserId: undefined };

function site(cwd: string, inContainer = false): RunForgeAccessSite {
  return { cwd, codebaseId: undefined, inContainer };
}

/** The common call: a declaring pack, freshly prepared, on the host. */
function assertFor(cwd: string, check: ForgeCheck): Promise<void> {
  return assertRunForgeAccess(noGithub, declaring, prepared, site(cwd), check);
}

async function refusal(run: Promise<void>): Promise<ForgeRequirementError['failures'] | undefined> {
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
    const noForge = { name: 'w', pack: { key: 'p', source: 'project' } } as const;
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
    const check = mock<ForgeCheck>(async ({ remote }) =>
      remote.includes('mirror')
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
    expect(check.mock.calls.map(([request]) => request.remote)).toEqual(['git@github.com:o/r.git']);
  });

  test('a remote is asked by the URL git fetches, after its insteadOf rewrite', async () => {
    const dir = checkout({ origin: 'gh:o/r.git' });
    Bun.spawnSync(['git', '-C', dir, 'config', 'url.git@github.com:.insteadOf', 'gh:']);
    const check = mock<ForgeCheck>(async () => undefined);
    await assertFor(dir, check);
    expect(check.mock.calls.map(([request]) => request.remote)).toEqual(['git@github.com:o/r.git']);
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
  const ops = ['pr.view'];

  test('a passing answer lets the run start', () => {
    expect(
      forgeCheckFailure(
        answer({
          ok: true,
          result: {
            op: 'check',
            value: { host: 'github.com', plugin: { name: 'github', version: '1' }, operations: [] },
          },
        }),
        exited(0),
        ops
      )
    ).toBeUndefined();
  });

  test.each(['no_plugin_for_host', 'unsupported_op', 'no_credential'] as const)(
    'the forge refusal %s keeps its kind and remedy',
    kind => {
      expect(
        forgeCheckFailure(
          answer({ ok: false, error: { kind, message: 'm' }, remedy: 'do this' }),
          exited(1),
          ops
        )
      ).toEqual({ reason: kind, message: 'm', remedy: 'do this' });
    }
  );

  test('any other failure, or no answer at all, is a check that failed', () => {
    expect(
      forgeCheckFailure(
        answer({ ok: false, error: { kind: 'process_failed', message: 'discovery failed' } }),
        exited(1),
        ops
      )
    ).toEqual({ reason: 'check_failed', message: 'discovery failed' });
  });

  test('a check with no answer names how it ended and how to rerun it, never its output', () => {
    const stopped = forgeCheckFailure('', { exitCode: null, signalCode: 'SIGTERM' }, ops);
    expect(stopped).toMatchObject({ reason: 'check_failed' });
    expect(stopped?.message).toContain('SIGTERM');
    expect(forgeCheckFailure('', exited(3), ops)).toMatchObject({ reason: 'check_failed' });
    const garbled = forgeCheckFailure('token=ghp_secret not json', exited(3), ops);
    expect(garbled?.message).toContain('3');
    expect(JSON.stringify(garbled)).not.toContain('ghp_secret');
    expect(garbled).toMatchObject({ reason: 'check_failed' });
    expect(garbled?.remedy).toContain('--data-file');
    expect(garbled?.remedy).toContain('pr.view');
  });
});
