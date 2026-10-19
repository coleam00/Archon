import { describe, test, expect } from 'bun:test';
import { parseGitHubHost, readGitHubHost, resolveGitHubHost } from './github-host';

describe('resolveGitHubHost', () => {
  const githubCom = {
    host: 'github.com',
    webUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com',
    graphqlUrl: 'https://api.github.com/graphql',
  };

  test.each([{}, { GITHUB_URL: '' }, { GITHUB_URL: 'https://github.com' }])(
    'resolves github.com for %j',
    env => {
      expect(resolveGitHubHost(env)).toEqual(githubCom);
    }
  );

  test.each([
    [
      'https://github.example.com/',
      {
        host: 'github.example.com',
        webUrl: 'https://github.example.com',
        apiBaseUrl: 'https://github.example.com/api/v3',
        graphqlUrl: 'https://github.example.com/api/graphql',
      },
    ],
    [
      'http://GHE.internal:8080',
      {
        host: 'ghe.internal:8080',
        webUrl: 'http://ghe.internal:8080',
        apiBaseUrl: 'http://ghe.internal:8080/api/v3',
        graphqlUrl: 'http://ghe.internal:8080/api/graphql',
      },
    ],
  ])('resolves the Enterprise host for GITHUB_URL=%s', (value, expected) => {
    expect(resolveGitHubHost({ GITHUB_URL: value })).toEqual(expected);
  });

  test.each([
    'not a url',
    'github.example.com',
    'ftp://github.example.com',
    'https://github.example.com/api/v3',
    'https://user:pass@github.example.com',
    'https://github.example.com/?x=1',
  ])('rejects GITHUB_URL=%s', value => {
    expect(() => resolveGitHubHost({ GITHUB_URL: value })).toThrow('GITHUB_URL');
    expect(readGitHubHost({ GITHUB_URL: value })).toBeNull();
  });

  test('does not echo a rejected value, which may carry credentials', () => {
    expect(() => resolveGitHubHost({ GITHUB_URL: 'https://user:secret@ghe.example' })).not.toThrow(
      'secret'
    );
  });
});

describe('parseGitHubHost', () => {
  test('maps a repository host to the same API roots as GITHUB_URL', () => {
    expect(parseGitHubHost('https://GitHub.com')?.apiBaseUrl).toBe('https://api.github.com');
    expect(parseGitHubHost('https://ghe.example.com:8443')?.apiBaseUrl).toBe(
      'https://ghe.example.com:8443/api/v3'
    );
  });
});
