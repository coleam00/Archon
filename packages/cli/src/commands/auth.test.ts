// @archon-test-isolated
import { expect, mock, spyOn, test } from 'bun:test';
import * as core from '@archon/core';
import * as paths from '@archon/paths';

const connectFailure = new Error('connection terminated unexpectedly');
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ error: () => undefined }),
}));
mock.module('../utils/cli-user', () => ({ resolveCliUserId: () => 'local-operator' }));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: async () => ({ id: 'user-1' }),
}));
mock.module('@archon/core', () => ({
  ...core,
  isPerUserGitHubEnabled: () => true,
  connectGithubForUser: async () => {
    throw connectFailure;
  },
}));

import { authGithubCommand } from './auth';

test('a failed GitHub connection exits 1 and reports the error', async () => {
  const output = spyOn(console, 'log').mockImplementation(() => undefined);
  const errorOutput = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(await authGithubCommand()).toBe(1);
    expect(errorOutput).toHaveBeenCalledWith(
      '\n✗ Connect failed: connection terminated unexpectedly'
    );
  } finally {
    output.mockRestore();
    errorOutput.mockRestore();
  }
});
