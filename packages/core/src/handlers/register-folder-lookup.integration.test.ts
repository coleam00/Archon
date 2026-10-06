// @archon-test-isolated
/**
 * Integration test: a folder project written by `registerFolder` is found again
 * by the lookups the CLI pre-dispatch gate and `archon doctor` use — against a
 * REAL bun:sqlite database, real directories, and a real directory link.
 *
 * This is the seam #2927 broke. `default_cwd` is matched by exact string
 * equality (and by a separator-anchored prefix), and the writer and the readers
 * each canonicalized it with a different realpath variant, so the row the CLI
 * wrote could not be found by the next command run in that same directory. The
 * link below reproduces that divergence class on POSIX; on Windows CI the
 * runner's `%TEMP%` is itself an 8.3 short path (`C:\Users\RUNNER~1\…`), so
 * these assertions run directly over the condition that produced the bug.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated) — it mock.module's
 * ./connection with a real adapter, which conflicts with the fakes other files
 * in this package install.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { mkdtemp, mkdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';

// Archon-owned storage (`_folder/<slug>/{artifacts,logs}`) is created for real
// by registerFolder; point it at a temp tree instead of the developer's ~/.archon.
const archonHome = await mkdtemp(join(tmpdir(), 'archon-folder-seam-home-'));
process.env.ARCHON_HOME = archonHome;

const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { registerFolder } = await import('./sql-registration');
const { findCodebaseByDefaultCwd, findCodebaseByPathPrefix } = await import('../db/codebases');
const { canonicalizeProjectPath } = await import('@archon/paths');

const tempRoots: string[] = [archonHome];

afterAll(async () => {
  for (const root of tempRoots) await removeTempTree(root);
});

/**
 * A real project root plus a second path that names the same directory through
 * a link. `'junction'` is ignored on POSIX and is the Windows link type that
 * needs no elevated privileges.
 */
async function makeLinkedRoot(name: string): Promise<{ realPath: string; linkPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'archon-folder-seam-'));
  tempRoots.push(root);
  const realPath = join(root, name);
  const linkPath = join(root, `${name}-link`);
  await mkdir(realPath);
  await symlink(realPath, linkPath, 'junction');
  return { realPath, linkPath };
}

describe('registerFolder ↔ folder-project lookup', () => {
  test('a project registered through a link is found from either path', async () => {
    const { realPath, linkPath } = await makeLinkedRoot('platform');

    const registered = await registerFolder(linkPath, 'platform');

    // The writer stores exactly the shared canonicalizer's output, not the path
    // it was handed. Everything below depends on that.
    expect(registered.defaultCwd).toBe(await canonicalizeProjectPath(linkPath));

    // Both spellings of the directory reach the one row, because both readers
    // resolve through the same canonicalizer the writer used.
    const viaLink = await findCodebaseByDefaultCwd(await canonicalizeProjectPath(linkPath));
    const viaReal = await findCodebaseByDefaultCwd(await canonicalizeProjectPath(realPath));
    expect(viaLink?.id).toBe(registered.codebaseId);
    expect(viaReal?.id).toBe(registered.codebaseId);
  });

  test('re-registering through the other path returns the same row, not a duplicate', async () => {
    const { realPath, linkPath } = await makeLinkedRoot('ops');

    const first = await registerFolder(linkPath, 'ops');
    const second = await registerFolder(realPath, 'ops');

    expect(second.alreadyExisted).toBe(true);
    expect(second.codebaseId).toBe(first.codebaseId);
  });

  test('a subdirectory of a registered root resolves through the prefix fallback', async () => {
    // The #2127 case: resume/approve re-enter with cwd = a path UNDER the
    // registered root, so the exact match misses and only the prefix match
    // rescues it. It is anchored on the separator, so it needs the canonical
    // ancestor — the same value registration stored.
    const { realPath, linkPath } = await makeLinkedRoot('multi-repo');
    const registered = await registerFolder(linkPath, 'multi-repo');

    const subdir = join(realPath, 'auth-service');
    await mkdir(subdir);

    expect(await findCodebaseByDefaultCwd(await canonicalizeProjectPath(subdir))).toBeNull();
    const found = await findCodebaseByPathPrefix(await canonicalizeProjectPath(subdir));
    expect(found?.id).toBe(registered.codebaseId);
  });
});
