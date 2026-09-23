import { resolve } from 'path';
import { BUNDLED_IS_BINARY } from './bundled-build';

/**
 * The argv that re-enters this install's `archon` CLI, without shell parsing.
 *
 * A compiled binary carries the CLI in itself, so `archon` and `archon serve`
 * resolve to the same executable. A source checkout runs the CLI entry that sits
 * beside this package, which is also where `bun run start` and `bun run dev`
 * start the server from. `--no-env-file` keeps Bun from loading the caller's
 * cwd `.env`; the CLI loads Archon's own env files itself.
 */
export function archonCliInvocation(): [string, ...string[]] {
  return BUNDLED_IS_BINARY
    ? [process.execPath]
    : [
        process.execPath,
        '--no-env-file',
        resolve(import.meta.dir, '..', '..', 'cli', 'src', 'cli.ts'),
      ];
}

/**
 * Publish the host command bundled workflow scripts use to call the CLI.
 *
 * Every host that executes workflows calls this at startup (the CLI and the
 * server), so a script sees the same `ARCHON_CLI_COMMAND` however its run was
 * launched. The value is a JSON string array. A container execution does not
 * inherit it: the host's executable path is not assumed to exist there.
 */
export function publishArchonCliCommand(env: NodeJS.ProcessEnv = process.env): void {
  env.ARCHON_CLI_COMMAND = JSON.stringify(archonCliInvocation());
}
