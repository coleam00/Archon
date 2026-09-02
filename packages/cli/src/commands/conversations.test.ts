/**
 * Tests for `archon conversations list --unowned` and `archon conversations
 * claim` — the escape hatch (#3135 Phase 7) for an install that turned web auth
 * on and found its pre-enforcement history owned by nobody.
 *
 * The database half of the safety (the `user_id IS NULL` clause) is asserted in
 * packages/core/src/db/{conversations,workflows}.test.ts. What matters here is
 * the order of the guards: an unknown target user, an unsupported platform, an
 * unparseable cutoff, and a missing confirmation must each refuse BEFORE
 * anything is written.
 *
 * Mocks precede the import of ./conversations.
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

const PRIVATE_PLATFORM_TYPES = ['web', 'cli'] as const;

interface FakeConversation {
  platform_type: string;
  platform_conversation_id: string;
  title: string | null;
  hidden: boolean;
  last_activity_at: Date | null;
}

function conversation(overrides: Partial<FakeConversation> = {}): FakeConversation {
  return {
    platform_type: 'web',
    platform_conversation_id: 'web-1712-abc123',
    title: 'Fix the login bug',
    hidden: false,
    last_activity_at: new Date('2026-08-30T11:02:13.000Z'),
    ...overrides,
  };
}

const mockListOwnerless = mock(
  async (_filter: unknown): Promise<readonly FakeConversation[]> => [conversation()]
);
const mockClaimConversations = mock(async (_userId: string, _filter: unknown) => 1);
const mockCountRuns = mock(async (_filter: unknown) => 0);
const mockClaimRuns = mock(async (_userId: string, _filter: unknown) => 0);
const mockGetUserById = mock(
  async (id: string): Promise<{ id: string; display_name: string | null } | null> => ({
    id,
    display_name: 'Alice',
  })
);

mock.module('@archon/core/db/conversations', () => ({
  PRIVATE_PLATFORM_TYPES,
  isPrivatePlatformType: (platform: string) =>
    (PRIVATE_PLATFORM_TYPES as readonly string[]).includes(platform),
  listOwnerlessConversations: mockListOwnerless,
  claimOwnerlessConversations: mockClaimConversations,
}));
mock.module('@archon/core/db/workflows', () => ({
  countOwnerlessRuns: mockCountRuns,
  claimOwnerlessRuns: mockClaimRuns,
}));
mock.module('@archon/core/db/users', () => ({
  getUserById: mockGetUserById,
}));

import { conversationsClaimCommand, conversationsListCommand } from './conversations';

let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

function printed(): string {
  return logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
}
function errors(): string {
  return errorSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
}
/** Neither table was touched. */
function expectNothingWritten(): void {
  expect(mockClaimConversations).not.toHaveBeenCalled();
  expect(mockClaimRuns).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockListOwnerless.mockClear();
  mockClaimConversations.mockClear();
  mockCountRuns.mockClear();
  mockClaimRuns.mockClear();
  mockGetUserById.mockClear();
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('conversations list', () => {
  test('requires --unowned and says what the view is for', async () => {
    expect(await conversationsListCommand({})).toBe(1);
    expect(errors()).toContain('--unowned');
    expect(mockListOwnerless).not.toHaveBeenCalled();
  });

  test('lists the rows a claim would take', async () => {
    mockListOwnerless.mockResolvedValueOnce([
      conversation(),
      conversation({
        platform_type: 'cli',
        platform_conversation_id: 'cli-1712-zzz999',
        title: null,
        last_activity_at: null,
      }),
    ]);

    expect(await conversationsListCommand({ unowned: true })).toBe(0);
    expect(mockListOwnerless).toHaveBeenCalledWith({ platformTypes: PRIVATE_PLATFORM_TYPES });
    const out = printed();
    expect(out).toContain('web-1712-abc123');
    expect(out).toContain('cli-1712-zzz999');
    expect(out).toContain('archon conversations claim --user');
  });

  test('narrows to one operator surface', async () => {
    mockListOwnerless.mockResolvedValueOnce([]);

    expect(await conversationsListCommand({ unowned: true, platform: 'cli' })).toBe(0);
    expect(mockListOwnerless).toHaveBeenCalledWith({ platformTypes: ['cli'] });
    expect(printed()).toContain('No unowned conversations');
  });

  // Stamping an owner on a Slack or GitHub row would not change who can read it,
  // but it WOULD decide who may act on the runs dispatched from it.
  test('refuses a platform privacy does not cover', async () => {
    expect(await conversationsListCommand({ unowned: true, platform: 'slack' })).toBe(1);
    expect(errors()).toContain('slack');
    expect(mockListOwnerless).not.toHaveBeenCalled();
  });

  test('rejects a nonsense --limit', async () => {
    expect(await conversationsListCommand({ unowned: true, limit: 'lots' })).toBe(1);
    expect(mockListOwnerless).not.toHaveBeenCalled();
  });

  test('truncates a long list and reports the full count', async () => {
    mockListOwnerless.mockResolvedValueOnce([conversation(), conversation(), conversation()]);

    expect(await conversationsListCommand({ unowned: true, limit: '2' })).toBe(0);
    expect(printed()).toContain('3 unowned');
    expect(printed()).toContain('showing 2');
  });
});

describe('conversations claim', () => {
  test('requires --user and points at where to find the id', async () => {
    expect(await conversationsClaimCommand({})).toBe(1);
    expect(errors()).toContain('console Settings');
    expect(mockGetUserById).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  // A typo would otherwise strand every claimed row on a user that does not
  // exist, which is harder to notice than a refusal.
  test('refuses an unknown --user before writing anything', async () => {
    mockGetUserById.mockResolvedValueOnce(null);

    expect(await conversationsClaimCommand({ user: 'not-a-user', yes: true })).toBe(1);
    expect(errors()).toContain('not-a-user');
    expect(mockListOwnerless).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  test('refuses an unparseable --before', async () => {
    expect(
      await conversationsClaimCommand({ user: 'user-1', before: 'last tuesday', yes: true })
    ).toBe(1);
    expect(mockGetUserById).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  test('--dry-run reports both counts and writes nothing', async () => {
    mockListOwnerless.mockResolvedValueOnce([conversation(), conversation()]);
    mockCountRuns.mockResolvedValueOnce(3);

    expect(await conversationsClaimCommand({ user: 'user-1', dryRun: true })).toBe(0);
    const out = printed();
    expect(out).toContain('conversations: 2');
    expect(out).toContain('workflow runs: 3');
    expect(out).toContain('--dry-run: nothing was written.');
    expectNothingWritten();
  });

  test('without --yes it refuses and writes nothing', async () => {
    mockListOwnerless.mockResolvedValueOnce([conversation()]);
    mockCountRuns.mockResolvedValueOnce(1);

    expect(await conversationsClaimCommand({ user: 'user-1' })).toBe(1);
    expect(errors()).toContain('--yes');
    expectNothingWritten();
  });

  test('with --yes it claims both tables for the resolved user', async () => {
    mockListOwnerless.mockResolvedValueOnce([conversation(), conversation()]);
    mockCountRuns.mockResolvedValueOnce(3);
    mockClaimConversations.mockResolvedValueOnce(2);
    mockClaimRuns.mockResolvedValueOnce(3);

    expect(await conversationsClaimCommand({ user: 'user-1', yes: true })).toBe(0);
    const filter = { platformTypes: PRIVATE_PLATFORM_TYPES, before: undefined };
    expect(mockClaimConversations).toHaveBeenCalledWith('user-1', filter);
    expect(mockClaimRuns).toHaveBeenCalledWith('user-1', filter);
    expect(printed()).toContain('Claimed 2 conversations and 3 workflow runs');
    expect(printed()).toContain('Alice');
  });

  test('threads --platform and --before into both claims', async () => {
    mockListOwnerless.mockResolvedValueOnce([conversation({ platform_type: 'cli' })]);
    mockCountRuns.mockResolvedValueOnce(0);
    mockClaimConversations.mockResolvedValueOnce(1);
    mockClaimRuns.mockResolvedValueOnce(0);

    expect(
      await conversationsClaimCommand({
        user: 'user-1',
        platform: 'cli',
        before: '2026-01-31',
        yes: true,
      })
    ).toBe(0);
    const filter = { platformTypes: ['cli'], before: new Date('2026-01-31') };
    expect(mockClaimConversations).toHaveBeenCalledWith('user-1', filter);
    expect(mockClaimRuns).toHaveBeenCalledWith('user-1', filter);
  });

  // Running it a second time as another user must be a no-op, not a transfer:
  // the store's `user_id IS NULL` clause is what guarantees it, and the command
  // stops before asking for confirmation it does not need.
  test('reports nothing to claim without asking for confirmation', async () => {
    mockListOwnerless.mockResolvedValueOnce([]);
    mockCountRuns.mockResolvedValueOnce(0);

    expect(await conversationsClaimCommand({ user: 'user-2' })).toBe(0);
    expect(printed()).toContain('Nothing to claim');
    expectNothingWritten();
  });
});
