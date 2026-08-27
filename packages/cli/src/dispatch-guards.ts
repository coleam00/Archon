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
 * Rejects any run config layer on a continuation run — whether it arrives as a
 * --config path or as a detached parent's sealed handoff payload: a resumed run
 * keeps the run config it started with. Deeper defense than
 * rejectConfigOnContinue: it also covers the detached handoff payload and
 * continuations that arrive through other subcommands.
 */
export function rejectConfigOnContinuation(
  isContinuation: boolean,
  resolvedRunConfigPath: string | undefined,
  detachedRunConfig: unknown
): string | undefined {
  if (isContinuation && (resolvedRunConfigPath !== undefined || detachedRunConfig !== undefined)) {
    return (
      '--resume and --config are mutually exclusive. ' +
      'A resumed run keeps its original run config.'
    );
  }
  return undefined;
}
