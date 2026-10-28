// @archon-test-isolated
import { describe, expect, mock, test } from 'bun:test';
import * as childProcess from 'child_process';

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

const execFile = mock(
  (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
    callback(null, { stdout: '12\n34\n', stderr: '' });
  }
);
mock.module('child_process', () => ({ ...childProcess, execFile }));

const { getLinkedIssueNumbers } = await import('./github-graphql');

describe('getLinkedIssueNumbers', () => {
  test('queries the given GitHub host through gh', async () => {
    expect(await getLinkedIssueNumbers('owner', 'repo', 7, 'ghe.example')).toEqual([12, 34]);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe('gh');
    expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'ghe.example']);
  });

  test('hands the GitHub PAT to gh as the Enterprise token for an Enterprise host', async () => {
    const saved = {
      GH_TOKEN: process.env.GH_TOKEN,
      GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
      GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
    };
    process.env.GH_TOKEN = 'ghp_pat';
    delete process.env.GH_ENTERPRISE_TOKEN;
    delete process.env.GITHUB_ENTERPRISE_TOKEN;
    try {
      execFile.mockClear();
      await getLinkedIssueNumbers('owner', 'repo', 7, 'ghe.example');
      expect(execFile.mock.calls[0][2]).toMatchObject({ env: { GH_ENTERPRISE_TOKEN: 'ghp_pat' } });

      execFile.mockClear();
      await getLinkedIssueNumbers('owner', 'repo', 7, 'github.com');
      expect(execFile.mock.calls[0][2]).toEqual({ timeout: 10000, env: undefined });

      // The operator's own Enterprise token, under either key gh reads, is left to gh.
      process.env.GITHUB_ENTERPRISE_TOKEN = 'ghe_operator';
      execFile.mockClear();
      await getLinkedIssueNumbers('owner', 'repo', 7, 'ghe.example');
      expect(execFile.mock.calls[0][2]).toEqual({ timeout: 10000, env: undefined });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
