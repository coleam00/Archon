/**
 * archon migrate:sqlite-to-postgres — CLI wrapper around the one-shot
 * migration script at scripts/migrate-sqlite-to-postgres.ts.
 *
 * Why spawn-and-stream (vs. direct import):
 *   - The script lives outside the CLI package boundary. Importing it
 *     via a relative path would pull `pg` + the script's full dep
 *     graph into the CLI bundle, even when the user is running
 *     unrelated commands like `archon workflow list`.
 *   - Bun is already a hard requirement for the CLI (the wrapper itself
 *     is a `.ts` file run via `bun`), so `Bun.spawn(['bun', ...])` is
 *     guaranteed to work in every supported environment.
 *   - Streaming stdout/stderr gives the user real-time feedback during
 *     the long-running migration (131k workflow_events row-by-row).
 *
 * Exit code contract matches the script: 0 success, 1 pre-flight, 2
 * migration abort, 3 verify mismatch.
 */
import { spawn } from 'bun';
import { resolve } from 'path';
import { parseArgs } from 'util';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts', 'migrate-sqlite-to-postgres.ts');

/** Pretty log line so the user knows what command is about to run. */
function log(msg: string): void {
  console.log(msg);
}

export async function migrateSqliteToPostgresCommand(args: string[]): Promise<number> {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        'batch-size': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    log(`Error: ${(err as Error).message}`);
    return 1;
  }

  const values = parsed.values;
  if (values.help) {
    log('Usage: archon migrate:sqlite-to-postgres [flags]');
    log('  --from <path>       Source SQLite file (default: ~/.archon/archon.db)');
    log('  --to <url>          Target Postgres connection string (default: $DATABASE_URL)');
    log('  --dry-run           Emit generated SQL batches, do not execute');
    log('  --verify            After import, compare row counts to source');
    log('  --batch-size <N>    Rows per multi-row INSERT (default: 1000)');
    log('  -h, --help          Show this help');
    return 0;
  }

  // Pass through only the flags the script understands — no cwd / verbose /
  // etc. here, this command runs the script as-is.
  const scriptArgs: string[] = [SCRIPT_PATH];
  if (typeof values.from === 'string') scriptArgs.push('--from', values.from);
  if (typeof values.to === 'string') scriptArgs.push('--to', values.to);
  if (values['dry-run']) scriptArgs.push('--dry-run');
  if (values.verify) scriptArgs.push('--verify');
  if (typeof values['batch-size'] === 'string') {
    scriptArgs.push('--batch-size', values['batch-size']);
  }

  log('archon migrate:sqlite-to-postgres — spawning migration script');
  log(`  script: ${SCRIPT_PATH}`);

  // Spawn bun to run the script. stdout/stderr pass through to the user.
  // inherit mode means the spinner and progress lines render in the
  // user's terminal as the script runs (no buffering).
  const proc = spawn({
    cmd: ['bun', 'run', ...scriptArgs],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });

  const exitCode = await proc.exited;
  return exitCode;
}
