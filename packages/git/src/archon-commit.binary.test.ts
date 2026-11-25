// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import * as paths from '@archon/paths';

// A compiled binary embeds its commit at build time; scripts/build-binaries.sh embeds
// 'unknown' when the build could not read one. Each case loads the reader afresh under its
// own embedded value.
async function readerEmbedding(commit: string): Promise<typeof import('./archon-commit')> {
  mock.module('@archon/paths', () => ({
    ...paths,
    BUNDLED_IS_BINARY: true,
    BUNDLED_GIT_COMMIT: commit,
  }));
  return import(`./archon-commit?embedded=${commit}`);
}

test('a binary built without a commit names none', async () => {
  const { readArchonCommit } = await readerEmbedding('unknown');
  expect(await readArchonCommit()).toBeUndefined();
});

test('a binary names the embedded hash and no commit date', async () => {
  const { readArchonCommit } = await readerEmbedding('abc1234');
  expect(await readArchonCommit()).toEqual({ sha: 'abc1234', committedAt: null });
});
