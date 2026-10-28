import { createLogger } from '@archon/paths';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import { writeJsonLine } from '../utils/stdout';

/** One parsed CLI invocation, as every route function receives it. */
export interface CliRouteContext {
  values: Record<string, unknown>;
  positionals: string[];
  command: string | undefined;
  subcommand: string | undefined;
  /** `--cwd` resolved, or the process working directory. */
  cwd: string;
  /** The directory the project gate resolved; equals `cwd` for commands the gate skips. */
  effectiveCwd: string;
  json: boolean | undefined;
  detachedRunConfig: WorkflowRunConfigInput | undefined;
  /** The environment the CLI inherited, before Archon env files loaded. */
  inheritedEnv: NodeJS.ProcessEnv;
  /** The environment forge commands trust (loadCliEnv's result). */
  forgeTrustedEnv: NodeJS.ProcessEnv;
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli');
  return cachedLog;
}

/**
 * Emit a failure message and return exit code 1. Under `--json` stdout must
 * stay exactly one machine-readable payload, so the diagnostic goes into an
 * `{ ok: false }` envelope there instead of bare stderr text (or stdout usage).
 */
export async function fail(json: boolean | undefined, message: string): Promise<1> {
  if (json) {
    await writeJsonLine({ ok: false, error: message });
  } else {
    console.error(message);
  }
  return 1;
}

/** Print help for `<command> [subcommand...]` positionals; none prints the global index. */
export async function printUsageFor(positionals: readonly string[] = []): Promise<void> {
  const { renderHelpFor } = await import('../help');
  console.log(renderHelpFor(positionals));
}
