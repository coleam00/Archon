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

export const RUN_PROJECT_CONFLICT_FLAGS = ['folder', 'base-branch', 'resume', 'dry-run'] as const;

/** Workflow subcommands that continue an existing run. */
const CONTINUE_SUBCOMMANDS: readonly string[] = [
  'resume',
  'approve',
  'reject',
  'respond',
  'answer',
];

/**
 * Continuations keep their model bindings and need an execution-capable host.
 */
export function isContinueSubcommand(subcommand: string | undefined): boolean {
  return subcommand !== undefined && CONTINUE_SUBCOMMANDS.includes(subcommand);
}

export const RESUME_RUN_CONFIG_CONFLICT =
  '--resume and --config are mutually exclusive. A resumed run keeps its original run config.';

/**
 * Rejects --model on subcommands that continue an existing workflow run: the
 * run keeps the model bindings it started with.
 */
export function rejectModelOnContinue(
  subcommand: string | undefined,
  model: unknown
): string | undefined {
  if (model !== undefined && isContinueSubcommand(subcommand)) {
    return (
      'Error: --model cannot be used when continuing an existing workflow run. ' +
      'The run keeps the model bindings it started with.'
    );
  }
  return undefined;
}

/**
 * Accepts run configuration and trigger deployment configuration on their owning commands.
 * `--config-from-run` names another run's run config, which only `workflow run` takes.
 */
export function rejectConfigOutsideRun(
  command: string | undefined,
  subcommand: string | undefined,
  config: unknown,
  configFromRun?: unknown
): string | undefined {
  const workflowRun = command === 'workflow' && subcommand === 'run';
  if (configFromRun !== undefined && !workflowRun) {
    return 'Error: --config-from-run can only be used with workflow run.';
  }
  const triggerConfig =
    command === 'trigger' && (subcommand === 'fire' || subcommand === 'schedule');
  if (config !== undefined && !triggerConfig && !workflowRun) {
    return 'Error: --config can only be used with workflow run, trigger fire, or trigger schedule.';
  }
  return undefined;
}

/**
 * Rejects a fresh --config or --config-from-run on `workflow run --resume`: the resumed
 * run keeps the config it started with.
 */
export function rejectConfigOnContinue(
  resume: boolean | undefined,
  config: unknown,
  configFromRun?: unknown
): string | undefined {
  if (!resume) return undefined;
  const flag =
    config !== undefined
      ? '--config'
      : configFromRun !== undefined
        ? '--config-from-run'
        : undefined;
  if (flag === undefined) return undefined;
  return (
    `Error: ${flag} cannot be used when continuing an existing workflow run. ` +
    'The run keeps the config it started with.'
  );
}
