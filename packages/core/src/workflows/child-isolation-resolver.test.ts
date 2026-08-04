/**
 * Child-isolation resolver — identifier uniqueness (#2121 slice 2, PR-A).
 *
 * The identifier becomes the child's branch name and its
 * `isolation_environments.workflow_id`. `WorktreeProvider.create()` ADOPTS an
 * existing worktree at the computed path with an INFO log and no error, so a
 * collision does not fail — it silently hands two children one checkout. These
 * tests pin the key at the granularity of the thing it names.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockProviderCreate = mock((_req: { identifier: string }) =>
  Promise.resolve({
    id: '/wt/path',
    provider: 'worktree' as const,
    workingPath: '/wt/path',
    branchName: 'archon/task-stub',
    status: 'active' as const,
    createdAt: new Date(),
    metadata: {},
  })
);

mock.module('@archon/isolation', () => ({
  getIsolationProvider: () => ({ create: mockProviderCreate }),
  classifyIsolationError: (err: Error) => err.message,
}));

const mockIsolationDbCreate = mock(() => Promise.resolve({ id: 'env-1' }));

mock.module('../db/isolation-environments', () => ({
  create: mockIsolationDbCreate,
}));

const { buildChildIdentifier, createChildWorktreeResolver } =
  await import('./child-isolation-resolver');

/** Mirrors `WorktreeProvider.slugify()` — the cap the identifier has to survive. */
const PROVIDER_SLUG_CAP = 50;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, PROVIDER_SLUG_CAP);
}

const PARENT_RUN_ID = '3f9a1c2b-1111-2222-3333-444455556666';

describe('buildChildIdentifier', () => {
  test('two nodes under the same parent get different identifiers', () => {
    const a = buildChildIdentifier(PARENT_RUN_ID, 'refactor-auth', 0);
    const b = buildChildIdentifier(PARENT_RUN_ID, 'refactor-billing', 0);

    expect(a).not.toBe(b);
    // The bug being fixed: both used to be `<parent8>-child-0`.
    expect(a).toContain('refactor-auth');
    expect(b).toContain('refactor-billing');
  });

  test('long node ids sharing a prefix survive the provider slug cap', () => {
    // Both exceed NODE_SLUG_MAX and are identical for the first 30 characters, so
    // a verbatim node id would truncate to the same branch — the same silent
    // adoption, just rarer. The hash suffix is what keeps them apart.
    const nodeA = 'implement-the-authentication-subsystem-part-one';
    const nodeB = 'implement-the-authentication-subsystem-part-two';

    const a = buildChildIdentifier(PARENT_RUN_ID, nodeA, 0);
    const b = buildChildIdentifier(PARENT_RUN_ID, nodeB, 0);

    expect(a).not.toBe(b);
    // Uniqueness has to hold AFTER the provider slugifies and truncates.
    expect(slugify(a)).not.toBe(slugify(b));
  });

  test('fan-out siblings on one node get different identifiers', () => {
    const first = buildChildIdentifier(PARENT_RUN_ID, 'review', 0);
    const second = buildChildIdentifier(PARENT_RUN_ID, 'review', 1);

    expect(first).not.toBe(second);
    expect(slugify(first)).not.toBe(slugify(second));
  });

  test('different parent runs do not collide on the same node', () => {
    const other = 'aaaaaaaa-1111-2222-3333-444455556666';

    expect(buildChildIdentifier(PARENT_RUN_ID, 'review', 0)).not.toBe(
      buildChildIdentifier(other, 'review', 0)
    );
  });

  test('stays inside the provider slug cap in the worst case', () => {
    // Longest realistic shape: a long node id and a 4-digit fan-out index. If this
    // ever exceeds the cap the child index gets truncated away and fan-out siblings
    // silently collide, so the assertion is on the SLUGIFIED length.
    const identifier = buildChildIdentifier(
      PARENT_RUN_ID,
      'an-extremely-long-node-identifier-that-an-author-might-plausibly-write',
      9999
    );

    expect(identifier.length).toBeLessThanOrEqual(PROVIDER_SLUG_CAP);
    expect(slugify(identifier)).toBe(identifier);
    expect(identifier.endsWith('-child-9999')).toBe(true);
  });

  test('is deterministic — resume recomputes the same branch', () => {
    expect(buildChildIdentifier(PARENT_RUN_ID, 'review', 2)).toBe(
      buildChildIdentifier(PARENT_RUN_ID, 'review', 2)
    );
  });

  test('is already slug-shaped, so workflow_id matches the branch suffix', () => {
    // The env row is stored under the identifier while the branch is derived by
    // slugifying it. If the two differ, an env row stops being findable from its
    // own branch name. 'abcdefghijklmno-p' truncates mid-separator, which is the
    // case that used to leave a '--' for slugify to collapse.
    for (const nodeId of [
      'review',
      'refactor-module',
      'abcdefghijklmno-p',
      'Review_Diff Node',
      'implement-the-authentication-subsystem-part-one',
    ]) {
      const identifier = buildChildIdentifier(PARENT_RUN_ID, nodeId, 0);
      expect(slugify(identifier)).toBe(identifier);
    }
  });
});

describe('createChildWorktreeResolver', () => {
  const parentRun = { id: PARENT_RUN_ID } as Parameters<
    ReturnType<typeof createChildWorktreeResolver>['resolve']
  >[0]['parentRun'];

  const resolver = createChildWorktreeResolver({
    codebaseId: 'cb-1',
    codebaseName: 'owner/repo',
    canonicalRepoPath: '/repo',
    baseBranch: 'main',
    createdByPlatform: 'cli',
  });

  beforeEach(() => {
    mockProviderCreate.mockClear();
    mockIsolationDbCreate.mockClear();
  });

  test('two isolated sub-run nodes in one parent request distinct worktrees', async () => {
    await resolver.resolve({ parentRun, nodeId: 'refactor-auth', codebaseId: 'cb-1' });
    await resolver.resolve({ parentRun, nodeId: 'refactor-billing', codebaseId: 'cb-1' });

    expect(mockProviderCreate).toHaveBeenCalledTimes(2);
    const [first, second] = mockProviderCreate.mock.calls.map(call => call[0].identifier);
    // Before the fix both were `<parent8>-child-0`, so the second create() adopted
    // the first child's worktree and the two children shared one checkout.
    expect(first).not.toBe(second);
  });
});
