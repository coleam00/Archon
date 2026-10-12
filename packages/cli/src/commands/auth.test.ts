// @archon-test-isolated
import { expect, mock, spyOn, test } from 'bun:test';
import * as core from '@archon/core';
import * as paths from '@archon/paths';

const logError = mock(() => undefined);
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ error: logError }),
}));
mock.module('../utils/cli-user', () => ({ resolveCliUserId: () => 'local-operator' }));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: async () => ({ id: 'user-1' }),
}));
mock.module('@archon/core', () => ({
  ...core,
  isPerUserGitHubEnabled: () => true,
  connectGithubForUser: async () => {
    throw Object.assign(new Error('Failed to store GitHub identity alice'), {
      code: '23505',
      detail: 'Key (platform_user_id)=(alice) already exists.',
    });
  },
}));

import { authGithubCommand } from './auth';

test('a failed GitHub connection logs internal correlation and the error code without identity data', async () => {
  const output = spyOn(console, 'log').mockImplementation(() => undefined);
  const errorOutput = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(await authGithubCommand()).toBe(1);
    expect(logError).toHaveBeenCalledWith(
      { userId: 'user-1', platform: 'github', errorType: 'Error', errorCode: '23505' },
      'cli.auth_github_failed'
    );
    expect(errorOutput).toHaveBeenCalledWith(
      '\n✗ Connect failed: Failed to store GitHub identity alice'
    );
  } finally {
    output.mockRestore();
    errorOutput.mockRestore();
  }
});
