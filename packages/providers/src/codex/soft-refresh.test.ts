import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const resolveCodexBinaryPathMock = mock(async () => '/fake/codex');
mock.module('./binary-resolver', () => ({
  resolveCodexBinaryPath: resolveCodexBinaryPathMock,
}));

interface FakeChildOptions {
  exitCode?: number;
  emitError?: Error;
  hang?: boolean;
  delayMs?: number;
  /** Optional callback to mutate auth.json mid-spawn (simulates the binary refreshing). */
  onSpawn?: () => void;
}

let fakeChildCfg: FakeChildOptions = { exitCode: 0 };

mock.module('child_process', () => ({
  spawn: mock(() => {
    const ee = new EventEmitter() as EventEmitter & { kill: (sig?: string) => void };
    ee.kill = () => {
      /* no-op */
    };

    const cfg = fakeChildCfg;
    setTimeout(() => {
      if (cfg.emitError) {
        ee.emit('error', cfg.emitError);
        return;
      }
      if (cfg.hang) {
        return; // never resolves; soft-refresh timeout should kick in
      }
      try {
        cfg.onSpawn?.();
      } catch {
        /* test bug — ignore */
      }
      ee.emit('exit', cfg.exitCode ?? 0);
    }, cfg.delayMs ?? 1);

    return ee;
  }),
}));

import { softRefreshCodex } from './soft-refresh';

let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

function authPath(): string {
  return path.join(tempHome, '.codex', 'auth.json');
}

function writeAuth(lastRefresh: string): void {
  fs.mkdirSync(path.dirname(authPath()), { recursive: true });
  fs.writeFileSync(
    authPath(),
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: 'ID_PLACEHOLDER',
          access_token: 'ACCESS_PLACEHOLDER',
          refresh_token: 'REFRESH_PLACEHOLDER',
          account_id: 'ACCT_PLACEHOLDER',
        },
        last_refresh: lastRefresh,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-soft-refresh-'));
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(tempHome);
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  resolveCodexBinaryPathMock.mockClear();
  resolveCodexBinaryPathMock.mockImplementation(async () => '/fake/codex');
  fakeChildCfg = { exitCode: 0 };
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('softRefreshCodex', () => {
  test('returns true when last_refresh advances after spawn', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    writeAuth(before);
    fakeChildCfg = {
      exitCode: 0,
      onSpawn: () => writeAuth(new Date().toISOString()),
    };
    const result = await softRefreshCodex();
    expect(result).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      'codex_soft_refresh_succeeded'
    );
  });

  test('returns false when last_refresh does not advance', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    writeAuth(before);
    fakeChildCfg = { exitCode: 0 };
    const result = await softRefreshCodex();
    expect(result).toBe(false);
  });

  test('returns false when binary spawn errors', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    writeAuth(before);
    fakeChildCfg = { emitError: new Error('ENOENT') };
    const result = await softRefreshCodex();
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      'codex_soft_refresh_failed_spawn'
    );
  });

  test('returns false when binary exits non-zero', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    writeAuth(before);
    fakeChildCfg = { exitCode: 1 };
    const result = await softRefreshCodex();
    expect(result).toBe(false);
  });

  test('returns false when no auth.json exists', async () => {
    const result = await softRefreshCodex();
    expect(result).toBe(false);
    // Binary should not be invoked because there's nothing to soft-refresh
    expect(resolveCodexBinaryPathMock).toHaveBeenCalledTimes(0);
  });

  test('returns false when binary resolution fails', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    writeAuth(before);
    resolveCodexBinaryPathMock.mockImplementationOnce(async () => {
      throw new Error('codex binary not found');
    });
    const result = await softRefreshCodex();
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      'codex_soft_refresh_binary_unresolved'
    );
  });
});
