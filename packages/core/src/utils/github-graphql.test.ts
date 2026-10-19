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
});
