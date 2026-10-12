import { describe, expect, test } from 'bun:test';
import { identityErrorLogFields } from './identity-error-log-fields';

describe('identityErrorLogFields', () => {
  test('keeps the database error code without personal data or query details', () => {
    const error = Object.assign(new Error('duplicate key for Alice'), {
      code: '23505',
      detail: 'Key (platform, platform_user_id)=(github, alice) already exists.',
      query: 'INSERT INTO remote_agent_users (display_name) VALUES (Alice)',
    });
    expect(identityErrorLogFields(error)).toEqual({ errorType: 'Error', errorCode: '23505' });
  });

  test('keeps the conflict type without the login in its message or properties', () => {
    const error = Object.assign(new Error('GitHub account @alice is already linked.'), {
      name: 'GithubIdentityConflictError',
      login: 'alice',
    });
    expect(identityErrorLogFields(error)).toEqual({ errorType: 'GithubIdentityConflictError' });
  });

  test('keeps a numeric vendor code without the echoed request body', () => {
    const error = Object.assign(new Error('Invalid Form Body name: Help @alice'), {
      name: 'DiscordAPIError[50035]',
      code: 50035,
      requestBody: { json: { name: 'Help @alice' } },
    });
    expect(identityErrorLogFields(error)).toEqual({
      errorType: 'DiscordAPIError[50035]',
      errorCode: 50035,
    });
  });

  test('does not log non-Error thrown values', () => {
    expect(identityErrorLogFields('alice')).toEqual({ errorType: 'string' });
    expect(identityErrorLogFields(null)).toEqual({ errorType: 'object' });
    expect(identityErrorLogFields({ code: { login: 'alice' } })).toEqual({ errorType: 'object' });
  });
});
