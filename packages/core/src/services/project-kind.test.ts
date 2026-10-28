// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import type { findRepoRoot } from '@archon/git';
const failure = new Error('sentinel Git failure');
const git = await import('@archon/git');
mock.module('@archon/git', () => ({
  ...git,
  findRepoRoot: mock<typeof findRepoRoot>(() => Promise.reject(failure)),
  trustRegisteredPath: mock(() => Promise.resolve()),
}));
const { detectProjectKind, ProjectKindDetectionError } = await import('./project-kind');
test('Git detection failures preserve the original cause for an existing path', async () => {
  const error = await detectProjectKind(import.meta.dir).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ProjectKindDetectionError);
  if (!(error instanceof ProjectKindDetectionError)) throw new Error('Expected detection error');
  expect(error.cause).toBe(failure);
});
