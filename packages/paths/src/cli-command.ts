import { resolve } from 'path';
import { BUNDLED_IS_BINARY } from './bundled-build';

/**
 * The argv that re-enters this install's `archon` CLI, without shell parsing.
 *
 * Call this from the CLI executable or a source server. A compiled server
 * inherits ARCHON_CLI_COMMAND from its launching CLI instead: its own executable
 * cannot re-enter the CLI. Source hosts run the sibling CLI entry with
 * `--no-env-file` so Bun does not load the caller's cwd `.env`.
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
 * The CLI and source server publish this at startup; a compiled server inherits
 * it from the CLI. The value is a JSON string array. A container execution does not
 * inherit it: the host's executable path is not assumed to exist there.
 */
export function publishArchonCliCommand(env: NodeJS.ProcessEnv = process.env): void {
  env.ARCHON_CLI_COMMAND = JSON.stringify(archonCliInvocation());
}
