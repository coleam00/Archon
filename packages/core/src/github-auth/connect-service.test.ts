import { mock, describe, test, expect, beforeEach } from 'bun:test';

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

const mockSave = mock(async () => {});
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
    mockLink.mockImplementationOnce(async () => {
      throw new Error('identity conflict');
    });
    await expect(connectGithubForUser('user-1', () => {})).rejects.toThrow('identity conflict');
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
