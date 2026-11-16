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

export const RUN_PROJECT_CONFLICT_FLAGS = ['folder', 'base-branch', 'dry-run'] as const;

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

/** What a continuation keeps from the start of the run, for each `workflow run` flag it refuses. */
const KEPT_ON_CONTINUE = {
  model: 'the model bindings',
  input: 'the inputs',
  base: 'the base branch',
} as const;

/**
 * Rejects `workflow run` flags that a subcommand continuing an existing run would otherwise
 * ignore: the run keeps what it started with, so a silently dropped value would mislead.
 */
export function rejectRunFlagsOnContinue(
  subcommand: string | undefined,
  values: Partial<Record<keyof typeof KEPT_ON_CONTINUE, unknown>>
): string | undefined {
  if (!isContinueSubcommand(subcommand)) return undefined;
  for (const [flag, kept] of Object.entries(KEPT_ON_CONTINUE)) {
    if (values[flag as keyof typeof KEPT_ON_CONTINUE] !== undefined)
      return (
        `Error: --${flag} cannot be used when continuing an existing workflow run. ` +
        `The run keeps ${kept} it started with.`
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
