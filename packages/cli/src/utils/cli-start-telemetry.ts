import { parseArgs } from 'util';
import { cliArgOptions } from '../args';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-control';

/**
 * Whether this CLI process reports its own `archon_started`. Every invocation
 * does — including help, version and argument errors — except two that another
 * process already reports: a `serve` that boots the server, whose boot sends the
 * `server` event with deployment shape, and a detached run owner, whose parent
 * CLI already counted the invocation. `serve --help` and `serve --download-only`
 * never boot the server, so the CLI counts them.
 */
export function shouldReportCliStart(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (env[DETACHED_RUN_OWNER_ENV] === '1') return false;
  // Lenient parse: only the command position matters here, and an unknown flag
  // must still be counted (the strict parse in main() reports it as an error).
  const { positionals, values } = parseArgs({
    args: [...args],
    options: cliArgOptions,
    allowPositionals: true,
    strict: false,
  });
  const bootsServer = positionals[0] === 'serve' && !values.help && !values['download-only'];
  return !bootsServer;
}
