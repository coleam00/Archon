import { parseArgs } from 'util';
import { cliArgOptions } from '../args';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-env';

/**
 * Whether this CLI process reports its own `archon_started`. Every invocation
 * does — including help, version and argument errors — except two that another
 * process already reports: `serve`, whose server boot sends the `server` event
 * with deployment shape, and a detached run owner, whose parent CLI already
 * counted the invocation.
 */
export function shouldReportCliStart(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (env[DETACHED_RUN_OWNER_ENV] === '1') return false;
  // Lenient parse: only the command position matters here, and an unknown flag
  // must still be counted (the strict parse in main() reports it as an error).
  const { positionals } = parseArgs({
    args: [...args],
    options: cliArgOptions,
    allowPositionals: true,
    strict: false,
  });
  return positionals[0] !== 'serve';
}
