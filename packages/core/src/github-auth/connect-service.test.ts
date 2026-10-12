// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import * as paths from '@archon/paths';
import { createMockLogger } from '../test/mocks/logger';
import type { SaveUserGithubTokenParams } from '../db/user-github-token-store';

const logger = createMockLogger();
mock.module('@archon/paths', () => ({ ...paths, createLogger: () => logger }));

// Device-flow + DB collaborators are mocked so the test exercises the
// orchestration (ordering, persistence, profile cache) without network or DB.
const device = {
  device_code: 'dc',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};
const token = {
  access_token: 'ghu_x',
  token_type: 'bearer',
  scope: '',
  expires_in: 28800,
  refresh_token: 'ghr_x',
  refresh_token_expires_in: 15897600,
};
const profile = { id: 42, login: 'alice', name: 'Alice', email: 'alice@example.com' };

const mockStart = mock(async () => device);
const mockPoll = mock(async () => token);
const mockFetchUser = mock(async () => profile);
mock.module('./device-flow', () => ({
  startDeviceFlow: mockStart,
  pollDeviceFlow: mockPoll,
  fetchGithubUser: mockFetchUser,
}));
mock.module('./config', () => ({ loadDeviceFlowConfig: () => ({ clientId: 'Iv1.test' }) }));

const mockSave = mock<(params: SaveUserGithubTokenParams) => Promise<void>>(async () => {});
mock.module('../db/user-github-token-store', () => ({ saveUserGithubToken: mockSave }));

const mockLink = mock(async () => {});
const mockUpdateProfile = mock(async () => {});
mock.module('../db/users', () => ({
  linkGithubIdentity: mockLink,
  updateUserGithubProfile: mockUpdateProfile,
}));

import { connectGithubForUser } from './connect-service';

describe('connectGithubForUser', () => {
  beforeEach(() => {
    logger.info.mockClear();
    logger.error.mockClear();
    mockStart.mockClear();
    mockPoll.mockClear();
    mockFetchUser.mockClear();
    mockSave.mockClear();
    mockLink.mockClear();
    mockUpdateProfile.mockClear();
  });

  test('drives the device flow and binds identity before persisting the token', async () => {
    const codes: string[] = [];
    const result = await connectGithubForUser('user-1', info => {
      codes.push(info.user_code);
    });

    expect(logger.info).toHaveBeenCalledWith(
      { userId: 'user-1', platform: 'github' },
      'github_connect.completed'
    );
    expect(result).toEqual({ githubLogin: 'alice' });
    expect(codes).toEqual(['ABCD-1234']);
    expect(mockLink).toHaveBeenCalledWith('user-1', 'alice');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      githubUserId: 42,
      githubLogin: 'alice',
      accessToken: 'ghu_x',
    });
    expect(mockUpdateProfile).toHaveBeenCalledWith('user-1', {
      display_name: 'Alice',
      email: 'alice@example.com',
    });
  });

  test('does NOT persist a token when the identity bind throws (no orphan row)', async () => {
    const conflict = Object.assign(new Error('identity conflict'), {
      name: 'GithubIdentityConflictError',
    });
    mockLink.mockImplementationOnce(async () => {
      throw conflict;
    });
    await expect(connectGithubForUser('user-1', () => {})).rejects.toThrow('identity conflict');
    expect(logger.error).toHaveBeenCalledWith(
      { err: conflict, userId: 'user-1', platform: 'github' },
      'github_connect.failed'
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
