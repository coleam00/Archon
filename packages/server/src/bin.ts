import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import { parseServerLaunchArgv, SERVER_LAUNCH_REQUIRED } from '@archon/paths/server-launch';
import type { ServerOptions } from './index';

export async function runServerEntry(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  loadServer: () => Promise<{ startServer: (options: ServerOptions) => Promise<void> }> = () =>
    import('./index')
): Promise<void> {
  const options = parseServerLaunchArgv(argv);
  const cliCommand = env.ARCHON_CLI_COMMAND;
  const logLevel = env.LOG_LEVEL;
  if (!cliCommand) throw new Error(SERVER_LAUNCH_REQUIRED);
  if (options.cliVersion !== BUNDLED_VERSION) {
    throw new Error(
      `archon-server version ${BUNDLED_VERSION} does not match CLI version ${options.cliVersion}. ` +
        'Run `archon serve --download-only` to fetch the matching server.'
    );
  }
  const { startServer } = await loadServer();
  // Application env loading must not replace the launcher-owned CLI command.
  env.ARCHON_CLI_COMMAND = cliCommand;
  if (logLevel) {
    const { setLogLevel } = await import('@archon/paths/logger');
    setLogLevel(logLevel);
  }
  await startServer({ port: options.port, webDistPath: options.webDistPath });
}

if (import.meta.main) {
  try {
    await runServerEntry(Bun.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
