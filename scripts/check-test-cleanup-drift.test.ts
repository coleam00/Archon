import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { buildLedger, checkRepository, checkSource, gitOutput } from './check-test-cleanup-drift';

const trackTempRoot = trackTempRoots();

const RETRY_SOURCE =
  "import { rm } from 'node:fs/promises';\nawait rm(root, { maxRetries: 10 });\n";
const CLEANUP_SOURCE = `
import { afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
`;

/**
 * A repository with no remotes and no branch history, which is the shape the check must work
 * in: the GitHub Actions checkout carries no \`origin/dev\` ref.
 *
 * Files are left untracked by default because the scan finds them either way and process
 * creation is the expensive part of this suite on Windows CI (#2882). One test opts into
 * `track` to prove the tracked half of the walk.
 */
function repositoryWith(files: Record<string, string>, { track = false } = {}): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'drift-check-')));
  gitOutput(['init'], root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (track) gitOutput(['add', '-A'], root);
  return root;
}

test('rejects Bun-inert rm retry options', () => {
  const violations = checkSource(
    'packages/example/src/example.ts',
    "import { rm } from 'node:fs/promises';\nawait rm(path, { recursive: true, maxRetries: 10, retryDelay: 50 });"
  );

  expect(violations).toEqual([
    expect.objectContaining({
      rule: 'retry-options',
      message: 'rm options must not use maxRetries or retryDelay; Bun ignores them',
    }),
  ]);
});

test('identifies bare recursive cleanup', () => {
  const violations = checkSource(
    'scripts/migrate-state-dir.test.ts',
    "import { rm } from 'node:fs/promises';\ntry { await run(); } finally { await rm(root, { recursive: true, force: true }); }"
  );

  expect(violations).toEqual([
    expect.objectContaining({
      rule: 'recursive-cleanup',
      message: 'recursive rm test cleanup must use removeTempTree or trackTempRoots',
    }),
  ]);
});

test('recognizes quoted cleanup option keys', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    afterEach(() => rm(root, { 'recursive': true }));
    rm(root, { 'maxRetries': 1, 'retryDelay': 1 });
  `;

  expect(checkSource('scripts/example.test.ts', source)).toHaveLength(2);
});

test('recognizes computed string-literal cleanup option keys', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    afterEach(() => rm(root, { ['recursive']: true }));
    rm(root, { ['maxRetries']: 1, ['retryDelay']: 1 });
  `;

  expect(checkSource('scripts/example.test.ts', source)).toHaveLength(2);
});

test('recognizes static fs promises bindings', () => {
  const source = `
    import { promises as fs } from 'node:fs';
    import * as nodeFs from 'fs';
    fs.rm(root, { maxRetries: 1 });
    nodeFs.promises.rm(root, { retryDelay: 1 });
  `;

  expect(checkSource('scripts/example.ts', source)).toHaveLength(2);
});

test('recognizes imported Bun cleanup hooks', () => {
  const source = `
    import { afterEach as cleanup } from 'bun:test';
    import * as Bun from 'bun:test';
    import { rm } from 'node:fs/promises';
    cleanup(() => rm(firstRoot, { recursive: true }));
    Bun.afterAll(() => rm(secondRoot, { recursive: true }));
  `;

  expect(checkSource('scripts/example.test.ts', source)).toHaveLength(2);
});

test('follows a named cleanup function passed to a hook by reference', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    async function cleanup() { await rm(root, { recursive: true, force: true }); }
    afterEach(cleanup);
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([
    expect.objectContaining({ rule: 'recursive-cleanup' }),
  ]);
});

test('follows a const-bound cleanup arrow passed to a hook by reference', () => {
  const source = `
    import { afterAll } from 'bun:test';
    import { rm } from 'node:fs/promises';
    const cleanup = async () => { await rm(root, { recursive: true, force: true }); };
    afterAll(cleanup);
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([
    expect.objectContaining({ rule: 'recursive-cleanup' }),
  ]);
});

test('treats setup hooks as cleanup, inline and by reference', () => {
  const inline = `
    import { beforeEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    beforeEach(async () => { await rm(root, { recursive: true, force: true }); });
  `;
  const referencedAlias = `
    import { beforeAll as prepare } from 'bun:test';
    import { rmSync } from 'node:fs';
    const wipe = () => rmSync(root, { recursive: true, force: true });
    prepare(wipe);
  `;

  expect(checkSource('packages/example/src/a.test.ts', inline)).toHaveLength(1);
  expect(checkSource('packages/example/src/b.test.ts', referencedAlias)).toHaveLength(1);
});

test('follows a helper called from inside an inline hook callback', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    async function cleanup() { await rm(root, { recursive: true, force: true }); }
    afterEach(async () => { await cleanup(); });
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([
    expect.objectContaining({ rule: 'recursive-cleanup' }),
  ]);
});

test('follows a cleanup call chain more than one hop from the hook', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    async function removeRoot() { await rm(root, { recursive: true, force: true }); }
    async function teardown() { await removeRoot(); }
    afterEach(teardown);
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([
    expect.objectContaining({ rule: 'recursive-cleanup' }),
  ]);
});

test('ignores a recursive helper reached only from a test body', () => {
  const source = `
    import { test } from 'bun:test';
    import { rm } from 'node:fs/promises';
    async function reset() { await rm(root, { recursive: true, force: true }); }
    test('example', async () => { await reset(); });
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([]);
});

test('ignores a recursive helper that is never passed to a hook', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    async function nukeFixture() { await rm(root, { recursive: true, force: true }); }
    afterEach(() => removeTempTree(root));
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([]);
});

test('rejects a malformed or duplicated ledger entry at construction', () => {
  expect(() =>
    buildLedger([
      ['a.test.ts', 1],
      ['a.test.ts', 2],
    ])
  ).toThrow('Duplicate cleanup ledger entry for a.test.ts');
  expect(() => buildLedger([['a.test.ts', 0]])).toThrow('must be a positive integer');
  expect(() => buildLedger([['a.test.ts', 1.5]])).toThrow('must be a positive integer');
  expect(buildLedger([['a.test.ts', 3]]).get('a.test.ts')).toBe(3);
});

test('allows single-file cleanup and shared recursive cleanup', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm, unlink } from 'node:fs/promises';
    afterEach(async () => {
      await unlink(socketPath);
      await removeTempTree(root);
    });
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([]);
});

/**
 * `ls-files` rejecting its own option is a local, constant-cost failure. An unknown *subcommand*
 * fails too, but only after Git searches every PATH entry for a `git-*` executable to offer a
 * correction: 5.3s of that on a Windows runner against the 5s per-test budget it then had
 * (#2882), where every other Git spawn in this file costs ~50ms.
 */
test('propagates Git scan failures', () => {
  expect(() => gitOutput(['ls-files', '--definitely-not-an-option'])).toThrow(
    'Git command failed: git ls-files --definitely-not-an-option'
  );
});

test('scans a repository that has no origin/dev ref', () => {
  const root = repositoryWith({ 'src/clean.test.ts': "import { rm } from 'node:fs/promises';\n" });

  expect(gitOutput(['remote'], root).trim()).toBe('');
  expect(checkRepository(root, new Map())).toEqual([]);
});

test('rejects retry options anywhere, in source and test files alike', () => {
  const root = repositoryWith({
    'packages/lib/src/cleanup.ts': RETRY_SOURCE,
    'packages/lib/src/cleanup.test.ts': RETRY_SOURCE,
  });

  expect(checkRepository(root, new Map()).sort()).toEqual([
    expect.stringContaining(
      'packages/lib/src/cleanup.test.ts:2 rm options must not use maxRetries'
    ),
    expect.stringContaining('packages/lib/src/cleanup.ts:2 rm options must not use maxRetries'),
  ]);
});

test('rejects recursive cleanup in a file the baseline does not record', () => {
  const root = repositoryWith({ 'packages/lib/src/fresh.test.ts': CLEANUP_SOURCE });

  expect(checkRepository(root, new Map())).toEqual([
    'packages/lib/src/fresh.test.ts:5 recursive rm test cleanup must use removeTempTree or trackTempRoots',
  ]);
});

test('finds tracked sources too, not only untracked ones', () => {
  const root = repositoryWith(
    { 'packages/lib/src/fresh.test.ts': CLEANUP_SOURCE },
    { track: true }
  );

  expect(gitOutput(['ls-files'], root).trim()).toBe('packages/lib/src/fresh.test.ts');
  expect(checkRepository(root, new Map())).toHaveLength(1);
});

test('accepts a recorded site at its count and reports a ledger left above it', () => {
  const root = repositoryWith({ 'packages/lib/src/legacy.test.ts': CLEANUP_SOURCE });

  expect(checkRepository(root, new Map([['packages/lib/src/legacy.test.ts', 1]]))).toEqual([]);
  expect(checkRepository(root, new Map([['packages/lib/src/legacy.test.ts', 4]]))).toEqual([
    expect.stringContaining('1 recursive cleanup sites, recorded 4; lower its'),
  ]);
});

test('rejects a recorded file that gains a site', () => {
  const root = repositoryWith({
    'packages/lib/src/legacy.test.ts': `${CLEANUP_SOURCE}\nafterEach(() => rm(other, { recursive: true }));\n`,
  });

  expect(checkRepository(root, new Map([['packages/lib/src/legacy.test.ts', 1]]))).toEqual([
    expect.stringContaining('2 recursive cleanup sites exceed the recorded 1'),
  ]);
});

test('reports a ledger entry for a file that no longer has any site', () => {
  const root = repositoryWith({ 'packages/lib/src/clean.test.ts': '' });

  expect(checkRepository(root, new Map([['packages/lib/src/deleted.test.ts', 2]]))).toEqual([
    expect.stringContaining('0 recursive cleanup sites, recorded 2; delete its'),
  ]);
});
