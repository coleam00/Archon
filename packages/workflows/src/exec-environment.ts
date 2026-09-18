export interface ExecNodeEnvironmentContext {
  artifactsDir: string;
  stateDir: string;
  logDir: string;
  workflowId: string;
  baseBranch: string;
  userMessage: string;
  loopUserInput: string;
  loopPrevOutput: string;
  rejectionReason: string;
  issueContext?: string;
  adoptedRunDir?: string | undefined;
}

export function buildExecNodeEnvironment(context: ExecNodeEnvironmentContext): NodeJS.ProcessEnv {
  const issueContext = context.issueContext ?? '';
  return {
    ARTIFACTS_DIR: context.artifactsDir,
    STATE_DIR: context.stateDir,
    LOG_DIR: context.logDir,
    ADOPTED_RUN_DIR: context.adoptedRunDir ?? '',
    // $WORKFLOW_ID substitutes into the body, but a heredoc'd python/node block
    // reads os.environ and found it missing while its siblings above were all
    // present. Deliver it the same way.
    WORKFLOW_ID: context.workflowId,
    BASE_BRANCH: context.baseBranch,
    USER_MESSAGE: context.userMessage,
    ARGUMENTS: context.userMessage,
    LOOP_USER_INPUT: context.loopUserInput,
    LOOP_PREV_OUTPUT: context.loopPrevOutput,
    REJECTION_REASON: context.rejectionReason,
    CONTEXT: issueContext,
    EXTERNAL_CONTEXT: issueContext,
    ISSUE_CONTEXT: issueContext,
  };
}

export const EXEC_NODE_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(
    buildExecNodeEnvironment({
      artifactsDir: '',
      stateDir: '',
      logDir: '',
      workflowId: '',
      baseBranch: '',
      userMessage: '',
      loopUserInput: '',
      loopPrevOutput: '',
      rejectionReason: '',
    })
  )
);

/**
 * Ensure `$HOME/.local/bin` is on PATH for a spawned node.
 *
 * WHY. The server's own PATH does not include it:
 *
 *   /app/packages/server:...:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
 *
 * That is the default install location for `uv`, `pipx`, `pip --user` and
 * `cargo install`, so any script node calling a user-installed tool dies with
 * `Executable not found in $PATH`. Observed on 0.6.0: a DAG workflow wrote its
 * commits, pushed them and opened a PR, then hit a `uv`-based validation node
 * and reported the whole run as failed — $19 of completed work recorded as a
 * failure, with the output intact but the report wrong.
 *
 * Both execution modes need it for different reasons. A HOST run layers
 * `process.env` and so inherits the server's incomplete PATH. A CONTAINER run
 * receives only the Archon-managed bag, which carries no PATH at all — so the
 * container falls back to whatever its image defaults to.
 *
 * Prepends rather than appends so a user-installed toolchain wins over a system
 * one, which is what a user installing into `~/.local/bin` is asking for. Idempotent,
 * and a no-op when HOME is unset rather than inventing a path from nothing.
 */
export function withUserLocalBin(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Only THIS env's HOME. Falling back to `process.env.HOME` would be wrong for
  // a container: the bag is the container's whole environment, and the server's
  // home path does not exist inside it. Prepending it would put a nonexistent
  // directory on PATH and quietly suggest the fix had been applied when the
  // real home was somewhere else. A host run already carries HOME here, merged
  // from process.env by the caller, so nothing is lost.
  const home = env.HOME;
  if (!home) return env;
  const userBin = `${home}/.local/bin`;
  const current = env.PATH ?? '';
  if (current.split(':').includes(userBin)) return env;
  return { ...env, PATH: current ? `${userBin}:${current}` : userBin };
}
