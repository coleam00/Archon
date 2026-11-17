import { describe, expect, test } from 'bun:test';
import { git } from './test-fixtures/git-harness';

describe('git utilities', () => {
  describe('branded types', () => {
    test.each([
      ['toRepoPath rejects empty string', git.toRepoPath, 'RepoPath cannot be empty'],
      ['toBranchName rejects empty string', git.toBranchName, 'BranchName cannot be empty'],
      ['toWorktreePath rejects empty string', git.toWorktreePath, 'WorktreePath cannot be empty'],
    ] as const)('%s', (_name, construct, message) => {
      expect(() => construct('')).toThrow(message);
    });
  });
});
