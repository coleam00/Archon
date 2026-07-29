#!/usr/bin/env bun
/**
 * Moves a repository's legacy `.archon/state/` contents into its external
 * `$STATE_DIR` (`~/.archon/workspaces/<project>/state/`).
 *
 * Why: `.archon/state/` was a prompt-level convention with no engine support.
 * Inside an isolated run it resolved to the *worktree*, so the cross-run memory
 * it held was destroyed at cleanup; in a user's repository it was stageable
 * (Archon never writes a `.gitignore`). `$STATE_DIR` (#2200) is the external,
 * per-project replacement. Archon itself never moves the legacy directory — it
 * warns once and leaves it alone — so this script is the operator's one-shot.
 *
 * It resolves the destination through the SAME helper the executor, the artifact
 * routes, and the CLI use (`resolveProjectStorageKey` + `getProjectStoragePaths`
 * in `@archon/paths`), so it cannot disagree with where runs actually read.
 *
 * Usage:
 *   bun run scripts/migrate-state-dir.ts                 # dry run (default)
 *   bun run scripts/migrate-state-dir.ts --apply         # actually move
 *   bun run scripts/migrate-state-dir.ts --cwd /path/to/repo [--apply]
 *
 * Safety:
 *   - Dry run by default; `--apply` is required to touch anything.
 *   - Never overwrites an existing destination file — it reports the conflict
 *     and exits non-zero so you resolve it deliberately.
 *   - Idempotent: re-running after a successful migration finds nothing to do.
 *   - Copy-then-delete, so an interrupted run leaves the source intact.
 *
 * Exit codes:
 *   0  nothing to do, dry run completed, or migration succeeded
 *   1  unexpected error
 *   2  destination conflicts found (nothing was moved)
 */
import { readdir, mkdir, stat, copyFile, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  resolveProjectStorageKey,
  getProjectStoragePaths,
  type ProjectStorageKey,
} from '@archon/paths';
import * as codebaseDb from '@archon/core/db/codebases';

const APPLY = process.argv.includes('--apply');
const cwdFlag = process.argv.indexOf('--cwd');
const CWD = cwdFlag !== -1 ? resolve(process.argv[cwdFlag + 1] ?? '.') : process.cwd();

/**
 * Resolve the storage key the same way a run would: look the project up by its
 * working directory, then delegate. An unregistered directory resolves to the
 * `_cwd` pseudo-project, exactly as the executor's fallback does.
 */
async function resolveKey(cwd: string): Promise<ProjectStorageKey> {
  try {
    const codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
    if (codebase) return resolveProjectStorageKey(codebase, cwd);
    console.log(`No registered project matches ${cwd} — using the _cwd fallback.`);
  } catch (error) {
    // A DB that is unreachable must not silently produce the wrong destination.
    console.error(`Could not read the codebase registry: ${(error as Error).message}`);
    process.exit(1);
  }
  return { kind: 'cwd', cwd };
}

async function main(): Promise<void> {
  const legacyDir = join(CWD, '.archon', 'state');
  const key = await resolveKey(CWD);
  const { stateRoot } = getProjectStoragePaths(key);

  console.log(`Repository:  ${CWD}`);
  console.log(`Legacy dir:  ${legacyDir}`);
  console.log(`$STATE_DIR:  ${stateRoot}`);
  console.log('');

  let entries: string[];
  try {
    entries = await readdir(legacyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('Nothing to migrate — no legacy .archon/state/ directory.');
      return;
    }
    throw error;
  }
  if (entries.length === 0) {
    console.log('Nothing to migrate — legacy .archon/state/ is empty.');
    return;
  }

  // Pre-flight: never clobber. Report every conflict at once rather than
  // failing halfway through a partial move.
  const conflicts: string[] = [];
  for (const name of entries) {
    try {
      await stat(join(stateRoot, name));
      conflicts.push(name);
    } catch {
      // Absent — safe to move.
    }
  }
  if (conflicts.length > 0) {
    console.error('Refusing to migrate — these already exist in $STATE_DIR:');
    for (const name of conflicts) console.error(`  ${join(stateRoot, name)}`);
    console.error('');
    console.error('Resolve each by hand (keep the newer copy), then re-run.');
    process.exit(2);
  }

  for (const name of entries) {
    console.log(`${APPLY ? 'move' : 'would move'}  ${name}`);
  }

  if (!APPLY) {
    console.log('');
    console.log(
      `Dry run — nothing was moved. Re-run with --apply to migrate ${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'}.`
    );
    return;
  }

  await mkdir(stateRoot, { recursive: true });
  for (const name of entries) {
    const src = join(legacyDir, name);
    const dest = join(stateRoot, name);
    const info = await stat(src);
    if (info.isDirectory()) {
      // State files are flat JSON in practice; a nested directory is unexpected
      // enough that silently flattening or recursing would be a guess.
      console.error(`Skipping directory (move it by hand): ${src}`);
      continue;
    }
    // Copy first, then remove — an interrupted run leaves the source intact.
    await copyFile(src, dest);
    await rm(src);
  }

  // Mark the destination initialized so a stateful workflow can tell a genuine
  // first run from an unmigrated one (see the triage workflows' ABORT guard).
  await writeFile(join(stateRoot, '.initialized'), '');

  console.log('');
  console.log(
    `Migrated ${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'} to ${stateRoot}`
  );
  console.log('Remaining step: confirm the legacy directory is empty, then remove it:');
  console.log(`  rmdir "${legacyDir}"`);
}

main().catch((error: unknown) => {
  console.error(`Migration failed: ${(error as Error).message}`);
  process.exit(1);
});
