import { describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { resolveCliArchonHome, resolveCliGlobalEnvPath } from './bootstrap-env';

describe('bootstrap env helpers', () => {
  it('defaults to ~/.archon when ARCHON_HOME is unset', () => {
    const env = { HOME: '/Users/tester' } as NodeJS.ProcessEnv;

    expect(resolveCliArchonHome(env)).toBe('/Users/tester/.archon');
    expect(resolveCliGlobalEnvPath(env)).toBe('/Users/tester/.archon/.env');
  });

  it('uses ARCHON_HOME when set to an absolute path', () => {
    const env = {
      HOME: '/Users/tester',
      ARCHON_HOME: '/tmp/custom-archon-home',
    } as NodeJS.ProcessEnv;

    expect(resolveCliArchonHome(env)).toBe('/tmp/custom-archon-home');
    expect(resolveCliGlobalEnvPath(env)).toBe('/tmp/custom-archon-home/.env');
  });

  it('expands a tilde ARCHON_HOME override', () => {
    const env = {
      HOME: '/Users/tester',
      ARCHON_HOME: '~/sandbox-archon-home',
    } as NodeJS.ProcessEnv;

    expect(resolveCliArchonHome(env)).toBe(`${homedir()}/sandbox-archon-home`);
    expect(resolveCliGlobalEnvPath(env)).toBe(`${homedir()}/sandbox-archon-home/.env`);
  });
});
