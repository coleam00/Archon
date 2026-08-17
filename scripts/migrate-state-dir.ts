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
 *   - The pre-flight decides the WHOLE migration before moving a byte, so any
 *     refusal (destination collision, nested directory) leaves the source
 *     untouched — a partial migration can never be reported as success.
 *   - `.initialized` is written ONLY after every entry moved, or when there was
 *     genuinely nothing to migrate. Marking a partial migration complete would
 *     tell the triage workflows' `state-preflight` gate that an incomplete state
 *     directory is authoritative — the exact reset the gate exists to prevent.
 *   - Idempotent: re-running after a successful migration finds nothing to do.
 *   - Copy-then-delete, so an interrupted run leaves the source intact.
 *
 * Exit codes:
 *   0  nothing to do, dry run completed, or migration fully succeeded
 *   1  unexpected error
 *   2  refused — destination collisions and/or nested directories; nothing was
 *      moved and `.initialized` was NOT written
 */
import { readdir, mkdir, stat, copyFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import {
  resolveProjectStorageKey,
  getProjectStoragePaths,
  type ProjectStorageKey,
} from '@archon/paths';
import { getDatabaseType, getSqliteDbPath } from '@archon/core/db/connection';
import * as codebaseDb from '@archon/core/db/codebases';

/**
 * Parse argv strictly. A migration tool that silently operates on the wrong
 * directory is the exact failure family this script exists to prevent, so a
 * malformed invocation exits non-zero rather than guessing: `--cwd --apply`
 * used to swallow the flag as a path, resolve to `<pwd>/--apply`, find no legacy
 * state, and report success while writing a junk `.initialized` marker.
 */
function parseArgs(argv: readonly string[]): { apply: boolean; cwd: string } {
  let apply = false;
  let cwd: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--cwd') {
      if (cwd !== undefined) {
        // Silently taking the last would let a copy-paste slip operate on a
        // different project than the one the operator is reading in their shell.
        console.error('--cwd was given more than once; pass it exactly once.');
        console.error('Usage: bun run scripts/migrate-state-dir.ts [--cwd <path>] [--apply]');
        process.exit(1);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        console.error(
          `--cwd requires a directory path${value === undefined ? '' : `, got '${value}'`}.`
        );
        console.error('Usage: bun run scripts/migrate-state-dir.ts [--cwd <path>] [--apply]');
        process.exit(1);
      }
      cwd = value;
      i++; // consume the value
      continue;
    }
    console.error(`Unknown argument: '${arg}'.`);
    console.error('Usage: bun run scripts/migrate-state-dir.ts [--cwd <path>] [--apply]');
    process.exit(1);
  }

  return { apply, cwd: resolve(cwd ?? '.') };
}

const { apply: APPLY, cwd: CWD } = parseArgs(process.argv.slice(2));

/**
 * Where a migration reads from and writes to, resolved from ONE anchor.
 *
 * The anchor exists because source and destination used to be derived
 * independently and could disagree. `findCodebaseByPathPrefix` matches any
 * SUBDIRECTORY of a registered project, so the destination climbed to the
 * project while the source stayed at the literal cwd. Run from
 * `<project>/packages/foo` and the script looked for legacy state under the
 * subdirectory, found none, declared "nothing to migrate", and wrote
 * `.initialized` into the REAL project's state root — disarming the
 * `state-preflight` gate for a project whose state was never migrated. Deriving
 * both from `anchor` makes that disagreement unrepresentable.
 */
interface MigrationTarget {
  key: ProjectStorageKey;
  /** The directory BOTH the legacy source and the destination derive from. */
  anchor: string;
  /** True when the anchor differs from the invocation cwd (climbed to a project root). */
  climbed: boolean;
}

/**
 * True when a registry lookup would have to CREATE the database to discover it
 * is empty.
 *
 * The SQLite adapter connects lazily and applies the full schema on first use,
 * so reading the codebase registry on a machine that has never run Archon
 * materialises `archon.db` plus a ~680 KB WAL — from a command whose own output
 * says `Dry run — nothing was moved`. No database means no registered projects,
 * which is already the `_cwd` fallback answer, so the read has nothing to tell
 * us that its side effect does not cost more than.
 *
 * Only sound for SQLite. A Postgres registry's contents cannot be inferred from
 * the local filesystem, so under DATABASE_URL the lookup always runs and an
 * unreachable database still exits 1 rather than guessing a destination.
 *
 * The path comes from `getSqliteDbPath()` rather than being rebuilt here, so this
 * can never end up asking about a different file than the adapter opens.
 */
function registryIsKnownEmpty(): boolean {
  return getDatabaseType() === 'sqlite' && !existsSync(getSqliteDbPath());
}

async function resolveTarget(cwd: string): Promise<MigrationTarget> {
  if (registryIsKnownEmpty()) {
    // Said out loud: a silent fallback to a different destination than the
    // operator expects is the failure family this script exists to prevent.
    console.log(`No codebase registry yet — using the _cwd fallback for ${cwd}.`);
    return { key: { kind: 'cwd', cwd }, anchor: cwd, climbed: false };
  }
  try {
    const codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
    if (codebase) {
      // resolveProjectStorageKey derives the destination from
      // codebase.default_cwd, so the source must anchor there too.
      const anchor = resolve(codebase.default_cwd);
      return {
        key: resolveProjectStorageKey(codebase, anchor),
        anchor,
        climbed: anchor !== cwd,
      };
    }
    console.log(`No registered project matches ${cwd} — using the _cwd fallback.`);
  } catch (error) {
    // A DB that is unreachable must not silently produce the wrong destination.
    console.error(`Could not read the codebase registry: ${(error as Error).message}`);
    process.exit(1);
  }
  return { key: { kind: 'cwd', cwd }, anchor: cwd, climbed: false };
}

/** True when `dir` exists and holds at least one entry. */
async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function plural(n: number): string {
  return `${String(n)} entr${n === 1 ? 'y' : 'ies'}`;
}

/**
 * Record that this project's `$STATE_DIR` is deliberately in its current shape —
 * either freshly migrated, or confirmed to have nothing to migrate. Stateful
 * workflows read this marker to tell "legitimately empty" from "state is still
 * sitting unmigrated somewhere else".
 *
 * Written ONLY on a fully successful `--apply`: a partial migration must never
 * be marked complete, or the marker waves through exactly the reset it exists
 * to prevent.
 */
async function markInitialized(stateRoot: string): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, '.initialized'), '');
}

/** True when `path` exists; narrowed to ENOENT so EACCES/EIO surface. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // A destination we cannot even stat must not be reported as "safe to move".
    throw error;
  }
}

/**
 * Nothing to migrate. On `--apply` this is still a successful outcome, so the
 * destination is marked — otherwise an operator who correctly runs the migration
 * on a project with no legacy state would be left with an unmarked `$STATE_DIR`.
 */
async function reportNoop(message: string, stateRoot: string): Promise<void> {
  console.log(message);
  if (!APPLY) {
    console.log('Dry run — re-run with --apply to mark $STATE_DIR initialized.');
    return;
  }
  await markInitialized(stateRoot);
  console.log(`Marked ${join(stateRoot, '.initialized')}`);
}

async function main(): Promise<void> {
  // The cwd must exist before anything else: `--cwd /typo` otherwise resolves to
  // the _cwd fallback, finds no legacy state, and reports a confident success
  // while marking a project directory nobody asked for.
  try {
    if (!(await stat(CWD)).isDirectory()) {
      console.error(`Not a directory: ${CWD}`);
      process.exit(1);
    }
  } catch {
    console.error(`Directory does not exist: ${CWD}`);
    console.error('Pass an existing project directory with --cwd, or omit it to use the cwd.');
    process.exit(1);
  }

  const { key, anchor, climbed } = await resolveTarget(CWD);
  const legacyDir = join(anchor, '.archon', 'state');
  const { stateRoot } = getProjectStoragePaths(key);

  console.log(`Project:     ${anchor}`);
  if (climbed) {
    console.log(`             (invoked from ${CWD}; resolved to the registered project root)`);
  }
  console.log(`Legacy dir:  ${legacyDir}`);
  console.log(`$STATE_DIR:  ${stateRoot}`);
  console.log('');

  // Climbing means the invocation cwd is NOT where we read from. If that cwd has
  // its own legacy state, migrating the project's and marking would leave the
  // subdirectory's unmigrated behind a satisfied marker — C5 all over again, one
  // level down. Ambiguous input gets a refusal, not a guess.
  if (climbed && (await hasEntries(join(CWD, '.archon', 'state')))) {
    console.error('Refusing to migrate — two candidate sources, and only one would be moved:');
    console.error(`  ${join(CWD, '.archon', 'state')}   (the directory you invoked from)`);
    console.error(`  ${legacyDir}   (the registered project root)`);
    console.error('');
    console.error('Re-run with --cwd pointing at exactly the one you mean.');
    process.exit(2);
  }

  let entries: string[];
  try {
    entries = await readdir(legacyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await reportNoop('Nothing to migrate — no legacy .archon/state/ directory.', stateRoot);
      return;
    }
    throw error;
  }
  if (entries.length === 0) {
    await reportNoop('Nothing to migrate — legacy .archon/state/ is empty.', stateRoot);
    return;
  }

  // Pre-flight: decide the ENTIRE migration before moving a single byte, so
  // every refusal leaves the source untouched and no partial move can be
  // reported as success. Two blocking conditions, reported together:
  //   - a destination file already exists (never clobber)
  //   - a nested directory (state files are flat JSON; recursing or flattening
  //     would be a guess, and skipping it would leave state behind)
  const conflicts: string[] = [];
  const directories: string[] = [];
  for (const name of entries) {
    if (await exists(join(stateRoot, name))) conflicts.push(name);
    const info = await stat(join(legacyDir, name));
    if (info.isDirectory()) directories.push(name);
  }

  if (conflicts.length > 0 || directories.length > 0) {
    console.error('Refusing to migrate — nothing was moved.');
    if (conflicts.length > 0) {
      console.error('');
      console.error('Already present in $STATE_DIR (resolve by hand, keep the newer copy):');
      for (const name of conflicts) console.error(`  ${join(stateRoot, name)}`);
    }
    if (directories.length > 0) {
      console.error('');
      console.error('Nested directories (move these by hand, then re-run):');
      for (const name of directories) console.error(`  ${join(legacyDir, name)}`);
    }
    console.error('');
    console.error('$STATE_DIR was NOT marked initialized — re-run after resolving.');
    process.exit(2);
  }

  if (!APPLY) {
    for (const name of entries) {
      console.log(`would move  ${name}`);
    }
    console.log('');
    console.log(
      `Dry run — nothing was moved. Re-run with --apply to migrate ${plural(entries.length)}.`
    );
    return;
  }

  await mkdir(stateRoot, { recursive: true });
  let moved = 0;
  for (const name of entries) {
    // Copy first, then remove — an interrupted run leaves the source intact.
    await copyFile(join(legacyDir, name), join(stateRoot, name));
    await rm(join(legacyDir, name));
    moved++;
    // Reported AFTER the move, so a run that dies partway through has not
    // already claimed entries it never got to.
    console.log(`moved  ${name}`);
  }

  // Every entry moved (the pre-flight guarantees no skips), so the destination
  // is now the complete state — safe to mark.
  await markInitialized(stateRoot);

  console.log('');
  console.log(`Migrated ${plural(moved)} to ${stateRoot}`);
  console.log('Remaining step: confirm the legacy directory is empty, then remove it:');
  console.log(`  rmdir "${legacyDir}"`);
}

main().catch((error: unknown) => {
  console.error(`Migration failed: ${(error as Error).message}`);
  process.exit(1);
});
