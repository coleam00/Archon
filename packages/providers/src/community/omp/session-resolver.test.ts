import { describe, expect, test } from 'bun:test';

import { resolveOmpSession } from './session-resolver';
import type { OmpCodingAgentSdk } from './sdk-loader';

function sdkWithSessions(
  sessions: Array<{ id: string; path: string }>
): Pick<OmpCodingAgentSdk, 'SessionManager'> {
  return {
    SessionManager: {
      getDefaultSessionDir(cwd: string, agentDir?: string) {
        return `${agentDir}/sessions/encoded-${cwd.replace('/', '')}`;
      },
      create(cwd: string, sessionDir?: string) {
        return { kind: 'create', cwd, sessionDir };
      },
      async list() {
        return sessions;
      },
      async open(filePath: string, sessionDir?: string) {
        return { kind: 'open', filePath, sessionDir };
      },
    },
  };
}

describe('resolveOmpSession', () => {
  test('creates fresh session with no resume id', async () => {
    await expect(resolveOmpSession(sdkWithSessions([]), '/repo', undefined)).resolves.toEqual({
      sessionManager: { kind: 'create', cwd: '/repo', sessionDir: undefined },
      resumeFailed: false,
    });
  });

  test('opens matching session', async () => {
    await expect(
      resolveOmpSession(sdkWithSessions([{ id: 'abc', path: '/s/abc.jsonl' }]), '/repo', 'abc')
    ).resolves.toEqual({
      sessionManager: { kind: 'open', filePath: '/s/abc.jsonl', sessionDir: undefined },
      resumeFailed: false,
    });
  });

  test('falls back to fresh session when resume id is missing', async () => {
    await expect(resolveOmpSession(sdkWithSessions([]), '/repo', 'missing')).resolves.toEqual({
      sessionManager: { kind: 'create', cwd: '/repo', sessionDir: undefined },
      resumeFailed: true,
    });
  });

  test('uses OMP default session directory for custom agentDir', async () => {
    await expect(
      resolveOmpSession(sdkWithSessions([]), '/repo', undefined, '/tmp/omp-agent')
    ).resolves.toEqual({
      sessionManager: {
        kind: 'create',
        cwd: '/repo',
        sessionDir: '/tmp/omp-agent/sessions/encoded-repo',
      },
      resumeFailed: false,
    });
  });

  test('falls back to fresh session when session listing throws', async () => {
    const sdk: Pick<OmpCodingAgentSdk, 'SessionManager'> = {
      SessionManager: {
        getDefaultSessionDir() {
          return '/tmp/omp-sessions';
        },
        create(cwd: string, sessionDir?: string) {
          return { kind: 'create', cwd, sessionDir };
        },
        async list() {
          const error = new Error('ENOENT') as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        },
        async open() {
          throw new Error('should not open');
        },
      },
    };

    await expect(resolveOmpSession(sdk, '/repo', 'abc')).resolves.toEqual({
      sessionManager: { kind: 'create', cwd: '/repo', sessionDir: undefined },
      resumeFailed: true,
    });
  });

  test('throws when opening a matching session fails unexpectedly', async () => {
    const sdk: Pick<OmpCodingAgentSdk, 'SessionManager'> = {
      SessionManager: {
        getDefaultSessionDir() {
          return '/tmp/omp-sessions';
        },
        create(cwd: string, sessionDir?: string) {
          return { kind: 'create', cwd, sessionDir };
        },
        async list() {
          return [{ id: 'abc', path: '/s/abc.jsonl' }];
        },
        async open() {
          throw new Error('open failed');
        },
      },
    };

    await expect(resolveOmpSession(sdk, '/repo', 'abc')).rejects.toThrow(
      "Oh My Pi session resume failed for 'abc': open failed"
    );
  });

  test('falls back to fresh session when opening a matching session is missing', async () => {
    const sdk: Pick<OmpCodingAgentSdk, 'SessionManager'> = {
      SessionManager: {
        getDefaultSessionDir() {
          return '/tmp/omp-sessions';
        },
        create(cwd: string, sessionDir?: string) {
          return { kind: 'create', cwd, sessionDir };
        },
        async list() {
          return [{ id: 'abc', path: '/s/abc.jsonl' }];
        },
        async open() {
          const error = new Error('ENOENT') as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        },
      },
    };

    await expect(resolveOmpSession(sdk, '/repo', 'abc')).resolves.toEqual({
      sessionManager: { kind: 'create', cwd: '/repo', sessionDir: undefined },
      resumeFailed: true,
    });
  });
});
