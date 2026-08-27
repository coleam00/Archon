/**
 * Pure pre-dispatch argv guards for the CLI.
 *
 * These checks run before any command dispatch and perform no I/O, so they are
 * extracted here — free of the module-load side effects cli.ts carries (env
 * loading, provider registration, `main()` invocation) — so tests can pin
 * their messages in-process instead of paying a full interpreter startup per
 * case. Each guard returns the error message to print before exiting 1, or
 * undefined when the invocation is allowed.
 */
import { resolve } from 'node:path';

/** Workflow subcommands that continue an existing run. */
const CONTINUE_SUBCOMMANDS = ['resume', 'approve', 'reject', 'respond'] as const;

/**
 * Rejects --model on subcommands that continue an existing workflow run: the
 * run keeps the model bindings it started with.
 */
export function rejectModelOnContinue(
  subcommand: string | undefined,
  model: unknown
): string | undefined {
  if (
    model !== undefined &&
    CONTINUE_SUBCOMMANDS.includes(subcommand as (typeof CONTINUE_SUBCOMMANDS)[number])
  ) {
    return (
      'Error: --model cannot be used when continuing an existing workflow run. ' +
      'The run keeps the model bindings it started with.'
    );
  }
  return undefined;
}

/**
 * Rejects --config for every command other than `workflow run`.
 */
export function rejectConfigOutsideRun(
  command: string | undefined,
  subcommand: string | undefined,
  config: unknown
): string | undefined {
  if (config !== undefined && (command !== 'workflow' || subcommand !== 'run')) {
    return 'Error: --config can only be used with workflow run.';
  }
  return undefined;
}

/**
 * Rejects a fresh --config on `workflow run --resume`: the resumed run keeps
 * the config it started with.
 */
export function rejectConfigOnContinue(
  resume: boolean | undefined,
  config: unknown
): string | undefined {
  if (resume && config !== undefined) {
    return (
      'Error: --config cannot be used when continuing an existing workflow run. ' +
      'The run keeps the config it started with.'
    );
  }
  return undefined;
}

/**
 * Resolves the effective run-config path from the parsed --config value
 * against the effective cwd (which honors an explicit --cwd subdirectory).
 * Path math only — never reads the filesystem.
 */
export function resolveRunConfigPath(cwd: string, config: unknown): string | undefined {
  return typeof config === 'string' ? resolve(cwd, config) : undefined;
}

/**
 * Rejects any run-config input (a fresh --config path or the detached handoff
 * payload) on a continuation: the resumed run keeps its original run config.
 * Called from the workflow run command AFTER the detached payload has been
 * parsed, which is why --resume plus an internal detached handoff surfaces
 * here rather than at the CLI-level rejectConfigOnContinue guard above.
 */
export function rejectRunConfigOnResume(
  isContinuation: boolean,
  hasRunConfigInput: boolean
): string | undefined {
  return isContinuation && hasRunConfigInput
    ? '--resume and --config are mutually exclusive. A resumed run keeps its original run config.'
    : undefined;
}
