import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getGitHubHost, getGitHubApiUrl, isPublicGitHub } from './github-host';

describe('github-host helpers', () => {
  let originalHost: string | undefined;
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalHost = process.env.GITHUB_HOST;
    originalApiUrl = process.env.GITHUB_API_URL;
    delete process.env.GITHUB_HOST;
    delete process.env.GITHUB_API_URL;
  });

  afterEach(() => {
    if (originalHost === undefined) delete process.env.GITHUB_HOST;
    else process.env.GITHUB_HOST = originalHost;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
  });

  describe('getGitHubHost', () => {
    test('defaults to github.com when unset', () => {
      expect(getGitHubHost()).toBe('github.com');
    });

    test('returns the configured host', () => {
      process.env.GITHUB_HOST = 'ghe.example.com';
      expect(getGitHubHost()).toBe('ghe.example.com');
    });

    test('lowercases the host', () => {
      process.env.GITHUB_HOST = 'GHE.Example.COM';
      expect(getGitHubHost()).toBe('ghe.example.com');
    });

    test('strips a leading scheme', () => {
      process.env.GITHUB_HOST = 'https://ghe.example.com';
      expect(getGitHubHost()).toBe('ghe.example.com');
    });

    test('strips trailing slashes', () => {
      process.env.GITHUB_HOST = 'ghe.example.com/';
      expect(getGitHubHost()).toBe('ghe.example.com');
    });

    test('treats whitespace-only as unset', () => {
      process.env.GITHUB_HOST = '   ';
      expect(getGitHubHost()).toBe('github.com');
    });
  });

  describe('getGitHubApiUrl', () => {
    test('returns undefined when unset (so Octokit uses its default)', () => {
      expect(getGitHubApiUrl()).toBeUndefined();
    });

    test('returns the configured URL verbatim', () => {
      process.env.GITHUB_API_URL = 'https://ghe.example.com/api/v3';
      expect(getGitHubApiUrl()).toBe('https://ghe.example.com/api/v3');
    });

    test('strips trailing slashes', () => {
      process.env.GITHUB_API_URL = 'https://ghe.example.com/api/v3/';
      expect(getGitHubApiUrl()).toBe('https://ghe.example.com/api/v3');
    });

    test('treats whitespace-only as unset', () => {
      process.env.GITHUB_API_URL = '  ';
      expect(getGitHubApiUrl()).toBeUndefined();
    });
  });

  describe('isPublicGitHub', () => {
    test('true when host is github.com', () => {
      expect(isPublicGitHub()).toBe(true);
    });

    test('false when host is GHE', () => {
      process.env.GITHUB_HOST = 'ghe.example.com';
      expect(isPublicGitHub()).toBe(false);
    });
  });
});
