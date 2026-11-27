/**
 * Start the Archon server on a throwaway home, to look at the console without touching a
 * real Archon install: `bun run dev:console [--port 3190] [--fresh] [--reopen-asks]`.
 *
 * - The home is `.console-home/` in this checkout (gitignored), so the server uses SQLite
 *   there and never reads ~/.archon/.env or a DATABASE_URL.
 * - When ARCHON_FACTORY_LIVE_HOME names the live factory's home (its launcher sets it, so
 *   every factory agent has it), the database is seeded once with a read-only copy of that
 *   home's archon.db (`VACUUM INTO`), so the console shows the factory's real items and runs.
 *   `--fresh` takes a new copy. The live database is only ever opened read-only. The copy's
 *   projects point at this checkout, so the console reads this branch's `.archon/` files.
 * - The live home's installed packs (`plugins/`) are copied in once too, so the console can
 *   draw their workflows' steps, prompts and YAML. `--fresh` copies them again.
 * - `--reopen-asks` reopens the newest wholly answered set of asks per item and workflow on the
 *   copy (`console-reopen-asks.ts`), so the factory's board and item pages show real asks; without it, and with
 *   `--fresh`, the copy shows what the live factory has open.
 * - It serves the built web UI (`bun run build:web` first) on the given port, default 3190.
 */
import { Database } from 'bun:sqlite';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { reopenAnsweredAsks } from './console-reopen-asks';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 3190;
const fresh = args.includes('--fresh');
const reopenAsks = args.includes('--reopen-asks');

const root = resolve(import.meta.dir, '..');
const home = join(root, '.console-home');
const db = join(home, 'archon.db');
const live = process.env.ARCHON_FACTORY_LIVE_HOME;

if (fresh && existsSync(home)) rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

if (live && !existsSync(db)) {
  const source = join(live, 'archon.db');
  if (existsSync(source)) {
    const src = new Database(source, { readonly: true });
    src.run(`VACUUM INTO '${db.replaceAll("'", "''")}'`);
    src.close();
    // The copy names the live factory's worktrees. A server sweeps active environments at
    // startup (cleanup-service.ts) and could remove one a live run is using, so the copy holds
    // none as active: this server only reads.
    const copy = new Database(db);
    copy.run(
      "UPDATE remote_agent_isolation_environments SET status = 'destroyed' WHERE status = 'active'"
    );
    // Projects read their `.archon/` from their checkout. Pointing them at this one makes the
    // console show this branch's files (a pack overlay a change adds, for example), not main's.
    copy.run('UPDATE remote_agent_codebases SET default_cwd = ?', [root]);
    copy.close();
    console.log(`Seeded ${db} from a read-only copy of the live factory database.`);
  }
}

// Only ever the throwaway copy: the database under this checkout's `.console-home/`, never the
// live home's.
if (reopenAsks && existsSync(db)) {
  const inside = relative(home, db);
  if (inside.startsWith('..') || (live !== undefined && resolve(db) === resolve(live, 'archon.db')))
    throw new Error(`--reopen-asks refuses ${db}: it is not the console's throwaway copy`);
  const copy = new Database(db);
  const reopened = reopenAnsweredAsks(copy);
  copy.close();
  console.log(`Reopened ${reopened.toString()} answered asks on the copy.`);
}

// The installed packs, so the console can draw their workflows' steps and prompts. Copied
// once, apart from the database, so a home seeded before this step gets them too.
const livePlugins = live && join(live, 'plugins');
const plugins = join(home, 'plugins');
if (livePlugins && existsSync(livePlugins) && !existsSync(plugins)) {
  cpSync(livePlugins, plugins, { recursive: true });
  console.log(`Copied the live factory's installed packs into ${plugins}.`);
}

const env: Record<string, string | undefined> = {
  ...process.env,
  ARCHON_HOME: home,
  PORT: String(port),
  DATABASE_URL: undefined,
  ARCHON_FACTORY_LIVE_SERVE: undefined,
};
delete env.DATABASE_URL;
delete env.ARCHON_FACTORY_LIVE_SERVE;

console.log(`Archon console on http://localhost:${port}/console (home ${home})`);
const child = Bun.spawn(['bun', 'packages/server/src/index.ts'], {
  cwd: root,
  env: env as Record<string, string>,
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(await child.exited);
