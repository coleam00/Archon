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
  if (!env.ARCHON_CLI_COMMAND) throw new Error(SERVER_LAUNCH_REQUIRED);
  if (options.cliVersion !== BUNDLED_VERSION) {
    throw new Error(
      `archon-server version ${BUNDLED_VERSION} does not match CLI version ${options.cliVersion}. ` +
        'Run `archon serve --download-only` to fetch the matching server.'
    );
  }
  const { startServer } = await loadServer();
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
