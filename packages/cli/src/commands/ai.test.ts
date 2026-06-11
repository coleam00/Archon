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

const SUBSCRIPTION = new Set<string>(['claude', 'codex', 'copilot']);
const mockStartOAuth = mock(
  async (_userId: string, _provider: string) =>
    ({
      sessionId: 's1',
      mode: 'device',
      userCode: 'WXYZ',
      verificationUri: 'https://x/dev',
      expiresIn: 600,
    }) as {
      sessionId: string;
      mode: 'manual' | 'device';
      url?: string;
      userCode?: string;
      verificationUri?: string;
      expiresIn: number;
    }
);
const mockPollOAuth = mock(
  (_sessionId: string, _userId: string, _code?: string) =>
    ({ status: 'connected' }) as { status: 'pending' | 'connected' | 'error'; detail?: string }
);

const mockUpdateGlobalConfig = mock(async (_updates: unknown) => {});
let loadConfigResult: {
  assistant: string;
  tiers?: Record<string, unknown>;
  aliases?: Record<string, unknown>;
} = {
  assistant: 'claude',
  tiers: {},
};
const mockLoadConfig = mock(async () => loadConfigResult);

// Per-user prefs store (Phase 3 --scope user surface)
let userPrefsResult: Record<string, unknown> = {};
const mockGetUserAiPrefs = mock(async (_userId: string) => userPrefsResult);
const mockSetUserTiers = mock(async (_userId: string, _patch: unknown) => {});
const mockSetUserAliases = mock(async (_userId: string, _patch: unknown) => {});
const mockSetUserDefaultProvider = mock(async (_userId: string, _provider: string | null) => {});

mock.module('@archon/core', () => ({
  isPerUserProviderKeysEnabled: () => enabled,
  persistProviderApiKey: mockPersist,
  listUserProviderKeys: mockList,
  deleteUserProviderKey: mockDelete,
  KNOWN_PROVIDERS: KNOWN,
  SUBSCRIPTION_PROVIDERS: SUBSCRIPTION,
  startOAuth: mockStartOAuth,
  pollOAuth: mockPollOAuth,
  loadConfig: mockLoadConfig,
  updateGlobalConfig: mockUpdateGlobalConfig,
  getUserAiPrefs: mockGetUserAiPrefs,
  setUserTiers: mockSetUserTiers,
  setUserAliases: mockSetUserAliases,
  setUserDefaultProvider: mockSetUserDefaultProvider,
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async () => ({ id: 'u1' })),
}));
mock.module('./auth', () => ({ resolveCliUserId: () => 'cli-alice' }));
mock.module('@archon/paths', () => ({ createLogger: noopLogger }));

// @archon/providers is NOT mocked — register builtins so isRegisteredProvider()
// (used by the tier/default commands) resolves claude/codex/etc.
import { registerBuiltinProviders } from '@archon/providers';
registerBuiltinProviders();

import {
  aiKeySetCommand,
  aiListCommand,
  aiLogoutCommand,
  aiLoginCommand,
  aiTierSetCommand,
  aiTierListCommand,
  aiTierUnsetCommand,
  aiAliasSetCommand,
  aiAliasListCommand,
  aiAliasUnsetCommand,
  aiDefaultCommand,
} from './ai';

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
  mockUpdateGlobalConfig.mockClear();
  mockLoadConfig.mockClear();
  mockGetUserAiPrefs.mockClear();
  mockSetUserTiers.mockClear();
  mockSetUserAliases.mockClear();
  mockSetUserDefaultProvider.mockClear();
  userPrefsResult = {};
  loadConfigResult = { assistant: 'claude', tiers: {} };
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

describe('aiLoginCommand', () => {
  beforeEach(() => {
    mockStartOAuth.mockClear();
    mockPollOAuth.mockClear();
  });

  it('gate off → 1, no bridge call', async () => {
    enabled = false;
    expect(await aiLoginCommand('claude')).toBe(1);
    expect(mockStartOAuth).not.toHaveBeenCalled();
  });

  it('missing provider → 1', async () => {
    expect(await aiLoginCommand(undefined)).toBe(1);
    expect(mockStartOAuth).not.toHaveBeenCalled();
  });

  it('non-subscription provider → 1, no bridge call', async () => {
    expect(await aiLoginCommand('openrouter')).toBe(1);
    expect(out()).toContain('does not support subscription login');
    expect(mockStartOAuth).not.toHaveBeenCalled();
  });

  it('device flow → connected → 0', async () => {
    mockStartOAuth.mockResolvedValueOnce({
      sessionId: 's1',
      mode: 'device',
      userCode: 'WXYZ',
      verificationUri: 'https://x/dev',
      expiresIn: 600,
    });
    mockPollOAuth.mockReturnValueOnce({ status: 'connected' });
    expect(await aiLoginCommand('copilot')).toBe(0);
    expect(mockStartOAuth).toHaveBeenCalledWith('u1', 'copilot');
    expect(out()).toContain('WXYZ');
  });

  it('device flow → error → 1', async () => {
    mockStartOAuth.mockResolvedValueOnce({
      sessionId: 's1',
      mode: 'device',
      userCode: 'WXYZ',
      verificationUri: 'https://x/dev',
      expiresIn: 600,
    });
    mockPollOAuth.mockReturnValueOnce({ status: 'error', detail: 'denied' });
    expect(await aiLoginCommand('copilot')).toBe(1);
    expect(out()).toContain('denied');
  });
});

describe('aiTierSetCommand', () => {
  it('sets a tier → 0 and writes a clean RawAliasEntry', async () => {
    expect(await aiTierSetCommand('large', 'claude', 'opus', 'high')).toBe(0);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.large).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });

  it('invalid tier name → 1, no write', async () => {
    expect(await aiTierSetCommand('huge', 'claude', 'opus', undefined)).toBe(1);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('unknown provider → 1, no write', async () => {
    expect(await aiTierSetCommand('large', 'bogus-provider', 'x', undefined)).toBe(1);
    expect(out()).toContain('Unknown provider');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('invalid effort for the provider → 1, no write', async () => {
    expect(await aiTierSetCommand('large', 'claude', 'opus', 'ultra')).toBe(1);
    expect(out()).toContain('Invalid effort');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('missing model → 1', async () => {
    expect(await aiTierSetCommand('large', 'claude', undefined, undefined)).toBe(1);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });
});

describe('aiTierUnsetCommand', () => {
  it('unset → 0 and writes null', async () => {
    expect(await aiTierUnsetCommand('medium')).toBe(0);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.medium).toBeNull();
  });

  it('invalid tier → 1, no write', async () => {
    expect(await aiTierUnsetCommand('xl')).toBe(1);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });
});

describe('aiTierListCommand', () => {
  it('lists configured tiers + built-in defaults, exits 0', async () => {
    loadConfigResult = {
      assistant: 'claude',
      tiers: { large: { provider: 'codex', model: 'gpt-5.5' } },
    };
    expect(await aiTierListCommand(false)).toBe(0);
    const text = out();
    expect(text).toContain('codex/gpt-5.5'); // configured large
    expect(text).toContain('default'); // unset tiers show their default
  });

  it('--json emits structured output', async () => {
    loadConfigResult = { assistant: 'claude', tiers: {} };
    expect(await aiTierListCommand(true)).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      defaultAssistant: string;
      tiers: unknown[];
    };
    expect(parsed.defaultAssistant).toBe('claude');
    expect(Array.isArray(parsed.tiers)).toBe(true);
  });
});

describe('aiDefaultCommand', () => {
  it('sets the default assistant → 0', async () => {
    expect(await aiDefaultCommand('codex')).toBe(0);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledWith({ defaultAssistant: 'codex' });
  });

  it('unknown provider → 1, no write', async () => {
    expect(await aiDefaultCommand('nope')).toBe(1);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });
});

describe('--scope user (per-user prefs, Phase 3)', () => {
  it('tier set --scope user → writes the DB store, not config.yaml', async () => {
    expect(await aiTierSetCommand('large', 'claude', 'opus', undefined, 'user')).toBe(0);
    expect(mockSetUserTiers).toHaveBeenCalledWith('u1', {
      large: { provider: 'claude', model: 'opus' },
    });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('tier set --scope install → config.yaml, not the DB store', async () => {
    expect(await aiTierSetCommand('large', 'claude', 'opus', undefined, 'install')).toBe(0);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    expect(mockSetUserTiers).not.toHaveBeenCalled();
  });

  it('invalid --scope value → 1, no writes', async () => {
    expect(await aiTierSetCommand('large', 'claude', 'opus', undefined, 'global')).toBe(1);
    expect(out()).toContain("Invalid --scope 'global'");
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
    expect(mockSetUserTiers).not.toHaveBeenCalled();
  });

  it('tier unset --scope user → null patch on the DB store', async () => {
    expect(await aiTierUnsetCommand('medium', 'user')).toBe(0);
    expect(mockSetUserTiers).toHaveBeenCalledWith('u1', { medium: null });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('default --scope user → per-user default provider', async () => {
    expect(await aiDefaultCommand('codex', 'user')).toBe(0);
    expect(mockSetUserDefaultProvider).toHaveBeenCalledWith('u1', 'codex');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('tier list shows the per-user override with a [just you] marker', async () => {
    loadConfigResult = {
      assistant: 'claude',
      tiers: { large: { provider: 'claude', model: 'opus' } },
    };
    userPrefsResult = { tiers: { large: { provider: 'codex', model: 'gpt-5.5' } } };
    expect(await aiTierListCommand(false)).toBe(0);
    const text = out();
    expect(text).toContain('codex/gpt-5.5');
    expect(text).toContain('[just you]');
  });
});

describe('aiAliasSetCommand', () => {
  it('sets an install alias → 0 via updateGlobalConfig', async () => {
    expect(await aiAliasSetCommand('@fast', 'claude', 'haiku', undefined, undefined)).toBe(0);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledWith({
      aliases: { '@fast': { provider: 'claude', model: 'haiku' } },
    });
  });

  it('--scope user → DB store', async () => {
    expect(await aiAliasSetCommand('@fast', 'claude', 'haiku', undefined, 'user')).toBe(0);
    expect(mockSetUserAliases).toHaveBeenCalledWith('u1', {
      '@fast': { provider: 'claude', model: 'haiku' },
    });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('reserved tier name → 1, no write', async () => {
    expect(await aiAliasSetCommand('large', 'claude', 'opus', undefined, undefined)).toBe(1);
    expect(out()).toContain('reserved');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('missing @ prefix → 1, no write', async () => {
    expect(await aiAliasSetCommand('fast', 'claude', 'haiku', undefined, undefined)).toBe(1);
    expect(out()).toContain("must start with '@'");
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  it('unknown provider → 1, no write', async () => {
    expect(await aiAliasSetCommand('@fast', 'bogus', 'x', undefined, undefined)).toBe(1);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });
});

describe('aiAliasUnsetCommand', () => {
  it('install scope → null patch via updateGlobalConfig', async () => {
    expect(await aiAliasUnsetCommand('@fast', undefined)).toBe(0);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledWith({ aliases: { '@fast': null } });
  });

  it('--scope user → null patch on the DB store', async () => {
    expect(await aiAliasUnsetCommand('@fast', 'user')).toBe(0);
    expect(mockSetUserAliases).toHaveBeenCalledWith('u1', { '@fast': null });
  });
});

describe('aiAliasListCommand', () => {
  it('merges install + user aliases, user wins, marker shown', async () => {
    loadConfigResult = {
      assistant: 'claude',
      aliases: {
        '@fast': { provider: 'claude', model: 'haiku' },
        '@deep': { provider: 'claude', model: 'opus' },
      },
    };
    userPrefsResult = { aliases: { '@fast': { provider: 'codex', model: 'gpt-5-mini' } } };
    expect(await aiAliasListCommand(false)).toBe(0);
    const text = out();
    expect(text).toContain('codex/gpt-5-mini');
    expect(text).toContain('[just you]');
    expect(text).toContain('claude/opus');
  });

  it('prints a hint when nothing is configured', async () => {
    expect(await aiAliasListCommand(false)).toBe(0);
    expect(out()).toContain('No @custom aliases configured');
  });

  it('--json emits structured rows', async () => {
    loadConfigResult = {
      assistant: 'claude',
      aliases: { '@fast': { provider: 'claude', model: 'haiku' } },
    };
    expect(await aiAliasListCommand(true)).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { aliases: unknown[] };
    expect(Array.isArray(parsed.aliases)).toBe(true);
    expect(parsed.aliases.length).toBe(1);
  });
});
