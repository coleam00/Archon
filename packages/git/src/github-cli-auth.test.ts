import { beforeEach, describe, expect, test, mock } from 'bun:test';
import {
  parseGitHubHostFromRemoteUrl,
  resolveGitHubCliAuthDecision,
  execGhWithAuthPolicy,
  stripGitHubCliTokens,
} from './github-cli-auth';

const mockExecFile = mock(
  async (
    _cmd: string,
    _args: string[],
    _options?: unknown
  ): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '',
    stderr: '',
  })
);

beforeEach(() => {
  mockExecFile.mockClear();
});

describe('parseGitHubHostFromRemoteUrl', () => {
  test('parses github.com from https remote', () => {
    expect(parseGitHubHostFromRemoteUrl('https://github.com/openai/codex.git')).toBe('github.com');
  });

  test('parses enterprise host from ssh remote', () => {
    expect(parseGitHubHostFromRemoteUrl('git@github.example.com:team/repo.git')).toBe(
      'github.example.com'
    );
  });

  test('returns null for non-GitHub remotes', () => {
    expect(parseGitHubHostFromRemoteUrl('https://gitlab.com/group/repo.git')).toBeNull();
  });
});

describe('stripGitHubCliTokens', () => {
  test('removes GH_TOKEN and GITHUB_TOKEN only', () => {
    expect(
      stripGitHubCliTokens({
        GH_TOKEN: 'gh',
        GITHUB_TOKEN: 'github',
        KEEP_ME: 'yes',
      })
    ).toEqual({
      KEEP_ME: 'yes',
    });
  });
});

describe('resolveGitHubCliAuthDecision', () => {
  test('keeps env auth when preference is inherit', async () => {
    const env = { GH_TOKEN: 'token', KEEP: 'yes' };
    const decision = await resolveGitHubCliAuthDecision({
      env,
      host: 'github.com',
      preference: 'inherit',
      execFile: mockExecFile,
    });

    expect(decision.chosenAuthSource).toBe('env');
    expect(decision.reason).toBe('inherit');
    expect(decision.env).toEqual(env);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('keeps env auth when no stored auth exists', async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'env-user',
              tokenSource: 'GH_TOKEN',
            },
          ],
        },
      }),
      stderr: '',
    });

    const decision = await resolveGitHubCliAuthDecision({
      env: { GH_TOKEN: 'token', KEEP: 'yes' },
      host: 'github.com',
      preference: 'prefer-stored',
      execFile: mockExecFile,
    });

    expect(decision.chosenAuthSource).toBe('env');
    expect(decision.reason).toBe('no_stored_auth');
    expect(decision.storedAuthAvailable).toBe(false);
    expect(decision.env).toEqual({ GH_TOKEN: 'token', KEEP: 'yes' });
  });

  test('strips env tokens when stored auth exists', async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'env-user',
              tokenSource: 'GITHUB_TOKEN',
            },
            {
              state: 'success',
              active: false,
              host: 'github.com',
              login: 'stored-user',
              tokenSource: 'keyring',
            },
          ],
        },
      }),
      stderr: '',
    });

    const decision = await resolveGitHubCliAuthDecision({
      env: { GH_TOKEN: 'token-a', GITHUB_TOKEN: 'token-b', KEEP: 'yes' },
      host: 'github.com',
      preference: 'prefer-stored',
      execFile: mockExecFile,
    });

    expect(decision.chosenAuthSource).toBe('stored');
    expect(decision.reason).toBe('prefer_stored');
    expect(decision.env).toEqual({ KEEP: 'yes' });
    expect(decision.activeLogin).toBe('env-user');
    expect(decision.storedLogin).toBe('stored-user');
    expect(decision.actorSwitchDetected).toBe(true);
  });

  test('returns non-github remote without calling gh status', async () => {
    const decision = await resolveGitHubCliAuthDecision({
      env: { GH_TOKEN: 'token' },
      repoPath: '/repo' as never,
      preference: 'prefer-stored',
      execFile: mockExecFile,
      getRemoteUrl: mock(async () => 'https://gitlab.com/group/repo.git'),
    });

    expect(decision.reason).toBe('non_github_remote');
    expect(decision.isGitHubHost).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('execGhWithAuthPolicy', () => {
  test('fails closed on actor switch for mutations', async () => {
    mockExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'env-user',
              tokenSource: 'GH_TOKEN',
            },
            {
              state: 'success',
              active: false,
              host: 'github.com',
              login: 'stored-user',
              tokenSource: 'keyring',
            },
          ],
        },
      }),
      stderr: '',
    });

    await expect(
      execGhWithAuthPolicy(['pr', 'create'], {
        env: { GH_TOKEN: 'token' },
        host: 'github.com',
        preference: 'prefer-stored',
        mutation: true,
        execFile: mockExecFile,
      })
    ).rejects.toThrow('Refusing GitHub mutation because auth fallback would switch actors');
  });

  test('executes gh with stripped env on stored-auth preference', async () => {
    mockExecFile
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              {
                state: 'success',
                active: true,
                host: 'github.com',
                login: 'same-user',
                tokenSource: 'GH_TOKEN',
              },
              {
                state: 'success',
                active: false,
                host: 'github.com',
                login: 'same-user',
                tokenSource: 'keyring',
              },
            ],
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '{"number":123}', stderr: '' });

    const result = await execGhWithAuthPolicy(['pr', 'view', '--json', 'number'], {
      env: { GH_TOKEN: 'token', KEEP: 'yes' },
      host: 'github.com',
      preference: 'prefer-stored',
      execFile: mockExecFile,
    });

    expect(result.stdout).toBe('{"number":123}');
    expect(result.decision.chosenAuthSource).toBe('stored');
    expect(mockExecFile.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ env: { KEEP: 'yes' } })
    );
  });
});
