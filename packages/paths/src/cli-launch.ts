import { fileURLToPath } from 'node:url';
import { BUNDLED_IS_BINARY } from './bundled-build';

/** Argv, not a shell command: source installs need Bun plus the CLI entry. */
export function archonCliCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: BUNDLED_IS_BINARY
      ? []
      : [fileURLToPath(new URL('../../cli/src/cli.ts', import.meta.url))],
  };
}

export function archonCliLaunchEnv(): Record<string, string> {
  const launch = archonCliCommand();
  return {
    ARCHON_EXECUTABLE: launch.command,
    ARCHON_EXECUTABLE_ARGS: JSON.stringify(launch.args),
  };
}
