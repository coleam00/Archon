import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectSourcePath } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { assertSavedCheckoutRemote, resolveSavedCheckout } from './registration-remote';

const trackRoot = trackTempRoots();
const remote = 'https://github.com/owner/repo';

async function fixture(createSource = true): Promise<{ root: string; source: string }> {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-saved-checkout-')));
  const source = join(root, 'source');
  if (createSource) await mkdir(source);
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

const previousArchonHome = process.env.ARCHON_HOME;
afterEach(() => {
  if (previousArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousArchonHome;
});

for (const suffix of ['/', '/../missing/../source']) {
  test(`returns a usable managed checkout path for suffix ${suffix}`, async () => {
    const { root } = await fixture();
    process.env.ARCHON_HOME = root;
    const source = getProjectSourcePath('owner', 'repo');
    await mkdir(source, { recursive: true });
    const saved = source + suffix;
    const checkout = await resolveSavedCheckout({ name: 'owner/repo', default_cwd: saved }, remote);
    expect(checkout).toBe(source);
    execFileSync('git', ['-C', checkout, 'init', '-q']);
  });
}

// Root ignores search permission, so these layouts would not fail inspection.
const canRevokeSearch = process.platform !== 'win32' && process.getuid?.() !== 0;

test.skipIf(!canRevokeSearch).each([
  {
    name: 'canonical managed source',
    saved: 'managed/source/',
    locked: 'managed',
    managed: 'managed/source',
  },
  { name: 'non-managed checkout', saved: 'foreign/inner', locked: 'foreign', managed: null },
])('refuses when the $name cannot be inspected', async ({ saved, locked, managed }) => {
  const { root } = await fixture(false);
  await mkdir(join(root, 'foreign', 'inner'), { recursive: true });
  await mkdir(join(root, 'managed', 'source'), { recursive: true });
  await chmod(join(root, locked), 0o000);
  try {
    const managedSource = managed && join(root, managed);
    const refusal = assertSavedCheckoutRemote(`${root}/${saved}`, remote, managedSource);
    await expect(refusal).rejects.toThrow('Cannot verify checkout ownership');
    await expect(refusal).rejects.toMatchObject({ cause: { code: 'EACCES' } });
  } finally {
    await chmod(join(root, locked), 0o755);
  }
});
