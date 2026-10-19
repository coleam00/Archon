import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { assertSavedCheckoutRemote } from './registration-remote';

const trackRoot = trackTempRoots();
const remote = 'https://github.com/owner/repo';

async function fixture(): Promise<{ root: string; source: string }> {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-saved-checkout-')));
  const source = join(root, 'source');
  await mkdir(source);
  return { root, source };
}

for (const suffix of ['', '/', '/./']) {
  test(`accepts an empty managed source with suffix ${JSON.stringify(suffix)}`, async () => {
    const { source } = await fixture();
    await assertSavedCheckoutRemote(source + suffix, remote, source);
  });

  test(`requires a managed clone root with suffix ${JSON.stringify(suffix)}`, async () => {
    const { root, source } = await fixture();
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
    await writeFile(join(source, 'partial'), 'incomplete clone');

    await expect(assertSavedCheckoutRemote(source + suffix, remote, source)).rejects.toThrow(
      'Cannot verify checkout ownership'
    );
  });
}

test('verifies non-managed empty directories even with a trailing slash', async () => {
  const { root, source } = await fixture();
  await expect(
    assertSavedCheckoutRemote(`${source}/`, remote, join(root, 'other'))
  ).rejects.toThrow('Cannot verify checkout ownership');
  await expect(assertSavedCheckoutRemote(`${source}/`, remote, null)).rejects.toThrow(
    'Cannot verify checkout ownership'
  );
});

test.skipIf(process.platform === 'win32')('does not treat a symlink alias as managed', async () => {
  const { root, source } = await fixture();
  const alias = join(root, 'alias');
  await symlink(source, alias);
  await expect(assertSavedCheckoutRemote(`${alias}/`, remote, source)).rejects.toThrow(
    'Cannot verify checkout ownership'
  );
});
