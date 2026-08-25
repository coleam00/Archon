import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import {
  captureDetachedInstallContext,
  restoreDetachedInstallContext,
} from './detached-install-context';

describe('detached install context', () => {
  it('round-trips absent wire sentinels back to absent variables', () => {
    const context = captureDetachedInstallContext({});
    const target: NodeJS.ProcessEnv = {
      TOKEN_ENCRYPTION_KEY: 'repo-key',
      ARCHON_HOME: '/repo/home',
      ARCHON_DOCKER: 'true',
      WORKSPACE_PATH: '/workspace',
      HOME: '/repo-user',
    };

    restoreDetachedInstallContext(context, target);

    expect(target).toEqual({});
    expect(target.HOME ?? homedir()).toBe(homedir());
  });

  it('restores every present install-context value', () => {
    const context = captureDetachedInstallContext({
      TOKEN_ENCRYPTION_KEY: 'parent-key',
      ARCHON_HOME: '/.archon',
      ARCHON_DOCKER: 'true',
      WORKSPACE_PATH: '/workspace',
      HOME: '/root',
    });
    const target: NodeJS.ProcessEnv = {};

    restoreDetachedInstallContext(context, target);

    expect(target).toEqual(context);
  });
});
