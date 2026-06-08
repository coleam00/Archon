import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks must precede the import of ./ai. The CLI handles secret input, so the
// surface is worth testing: gate, validation (before any DB / key read), the
// I1 logout-typo guard, I2 DB-error handling, and the I4 piped-stdin contract.
// Runs in its own `bun test` batch — it mock.module()s @archon/core (which other
// cli tests also mock with a different shape).
// ---------------------------------------------------------------------------

const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

let enabled = true;
const KNOWN = new Set<string>(['claude', 'codex', 'openrouter', 'anthropic', 'openai']);

const mockPersist = mock(
  async (_userId: string, provider: string, _apiKey: string, label?: string | null) => ({
    provider,
    kind: 'api_key' as const,
    label: label ?? null,
  })
);
const mockList = mock(
  async (_userId: string) =>
    [] as { provider: string; kind: 'api_key' | 'oauth'; label: string | null }[]
);
const mockDelete = mock(async (_userId: string, _provider: string) => {});

mock.module('@archon/core', () => ({
  isPerUserProviderKeysEnabled: () => enabled,
  persistProviderApiKey: mockPersist,
  listUserProviderKeys: mockList,
  deleteUserProviderKey: mockDelete,
  KNOWN_PROVIDERS: KNOWN,
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async () => ({ id: 'u1' })),
}));
mock.module('./auth', () => ({ resolveCliUserId: () => 'cli-alice' }));
mock.module('@archon/paths', () => ({ createLogger: noopLogger }));

import { aiKeySetCommand, aiListCommand, aiLogoutCommand, aiLoginNotImplemented } from './ai';

let logSpy: ReturnType<typeof spyOn<Console, 'log'>>;
let errSpy: ReturnType<typeof spyOn<Console, 'error'>>;
function out(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');
}

beforeEach(() => {
  enabled = true;
  mockPersist.mockClear();
  mockList.mockClear();
  mockDelete.mockClear();
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errSpy = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('gate (TOKEN_ENCRYPTION_KEY off)', () => {
  it('every command exits 1 with guidance and never touches the store', async () => {
    enabled = false;
    expect(await aiKeySetCommand('openrouter')).toBe(1);
    expect(await aiListCommand()).toBe(1);
    expect(await aiLogoutCommand('openrouter')).toBe(1);
    expect(out()).toContain('TOKEN_ENCRYPTION_KEY');
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('aiKeySetCommand — validation before reading the key', () => {
  it('missing provider → 1, no store write', async () => {
    expect(await aiKeySetCommand(undefined)).toBe(1);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('unknown provider → 1 with the known list, no store write', async () => {
    expect(await aiKeySetCommand('bogus')).toBe(1);
    expect(out()).toContain("Unknown provider 'bogus'");
    expect(mockPersist).not.toHaveBeenCalled();
  });
});

describe('aiKeySetCommand — piped stdin (secret input, never argv)', () => {
  let savedTTY: boolean | undefined;
  let stdinSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    const s = process.stdin as unknown as { isTTY?: boolean };
    savedTTY = s.isTTY;
    s.isTTY = false;
  });
  afterEach(() => {
    (process.stdin as unknown as { isTTY?: boolean }).isTTY = savedTTY;
    stdinSpy?.mockRestore();
  });

  it('stores a trimmed piped key and returns 0', async () => {
    stdinSpy = spyOn(Bun.stdin, 'text').mockResolvedValue('  sk-piped-123  ');
    expect(await aiKeySetCommand('openrouter')).toBe(0);
    expect(mockPersist).toHaveBeenCalledWith('u1', 'openrouter', 'sk-piped-123');
  });

  it('empty piped stdin → 1 with a message, no store write (I4)', async () => {
    stdinSpy = spyOn(Bun.stdin, 'text').mockResolvedValue('   ');
    expect(await aiKeySetCommand('openrouter')).toBe(1);
    expect(out()).toContain('No API key provided on stdin');
    expect(mockPersist).not.toHaveBeenCalled();
  });
});

describe('aiListCommand', () => {
  it('prints a hint and returns 0 when nothing is connected', async () => {
    mockList.mockResolvedValueOnce([]);
    expect(await aiListCommand()).toBe(0);
    expect(out()).toContain('No AI provider keys connected');
  });

  it('lists connections and returns 0', async () => {
    mockList.mockResolvedValueOnce([{ provider: 'openrouter', kind: 'api_key', label: 'mine' }]);
    expect(await aiListCommand()).toBe(0);
    expect(out()).toContain('openrouter');
    expect(out()).toContain('mine');
  });

  it('DB failure → 1 (I2)', async () => {
    mockList.mockRejectedValueOnce(new Error('db down'));
    expect(await aiListCommand()).toBe(1);
    expect(out()).toContain('Failed to list provider keys');
  });
});

describe('aiLogoutCommand', () => {
  it('unknown provider → 1, no delete (I1)', async () => {
    expect(await aiLogoutCommand('bogus')).toBe(1);
    expect(out()).toContain("Unknown provider 'bogus'");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('known provider → 0 and calls delete', async () => {
    expect(await aiLogoutCommand('openrouter')).toBe(0);
    expect(mockDelete).toHaveBeenCalledWith('u1', 'openrouter');
  });

  it('DB failure → 1 (I2)', async () => {
    mockDelete.mockRejectedValueOnce(new Error('db down'));
    expect(await aiLogoutCommand('openrouter')).toBe(1);
    expect(out()).toContain("Failed to disconnect 'openrouter'");
  });
});

describe('aiLoginNotImplemented', () => {
  it('returns 1 and points at `key set`', () => {
    expect(aiLoginNotImplemented()).toBe(1);
    expect(out()).toContain('archon ai key set');
  });
});
