import type { NodeExecutionMetadata } from './schemas/node-execution';
import { USER_CONTROLLED_VARIABLES } from './user-controlled-variables';

/** The part of a node's execution record its own process may read. */
export type NodeExecutionIdentity = Pick<
  NodeExecutionMetadata,
  'runId' | 'path' | 'invocation' | 'attempt'
>;

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
  /**
   * This invocation's typed-artifact listing. Required so a real invocation cannot
   * forget it and hand its script an empty pointer; only a caller with no listing
   * (the dry run) passes `''` explicitly. The path is inside the run's artifact dir,
   * so a container that mounts it reads the same bytes at the same path.
   */
  typedArtifactsFile: string;
  /**
   * The execution this process belongs to: identity plus the invocation's and this
   * attempt's checkout starts (#3375). Carries manifest pointers and digests, never
   * manifest contents. Required for the same reason as `typedArtifactsFile`; only a
   * caller with no execution record passes `null`, which delivers an empty value.
   */
  nodeExecution: NodeExecutionIdentity | null;
  inputEnvKeys: readonly string[];
}

export function buildExecNodeEnvironment(context: ExecNodeEnvironmentContext): NodeJS.ProcessEnv {
  const userVariables: Record<string, string> = {};
  for (const group of USER_CONTROLLED_VARIABLES) {
    for (const name of group.names) userVariables[name] = context[group.source] ?? '';
  }
  const env: Record<string, string> = {
    ARTIFACTS_DIR: context.artifactsDir,
    STATE_DIR: context.stateDir,
    LOG_DIR: context.logDir,
    ADOPTED_RUN_DIR: context.adoptedRunDir ?? '',
    // $WORKFLOW_ID substitutes into the body, but a heredoc'd python/node block
    // reads os.environ and found it missing while its siblings above were all
    // present. Deliver it the same way.
    WORKFLOW_ID: context.workflowId,
    BASE_BRANCH: context.baseBranch,
    ...userVariables,
    // The listing path, delivered like the other engine-reserved keys: configured
    // project env and node bindings spread before this bag, so neither can shadow it.
    TYPED_ARTIFACTS_FILE: context.typedArtifactsFile,
    ARCHON_RUN_ENV_KEYS: '',
    ARCHON_NODE_EXECUTION:
      context.nodeExecution === null ? '' : nodeExecutionEnvValue(context.nodeExecution),
  };
  env.ARCHON_RUN_ENV_KEYS = JSON.stringify([...Object.keys(env), ...context.inputEnvKeys]);
  return env;
}

function nodeExecutionEnvValue(execution: NodeExecutionIdentity): string {
  return JSON.stringify({
    runId: execution.runId,
    path: execution.path,
    invocation: execution.invocation,
    attempt: execution.attempt,
  });
}

/**
 * The run identity an AI node's provider subprocess carries, so an `archon state`
 * write from the agent's shell records this run and node (#4059). Spread after the
 * configured project env so none of these keys can be shadowed by it. `ARCHON_CLI_COMMAND`
 * is always owned here, empty when the host has none to give (a container does not have the
 * host executable), so a project-env value never stands in for it.
 */
export function buildAiNodeEnvironment(
  execution: NodeExecutionIdentity,
  cliCommand: string | undefined
): Record<string, string> {
  return {
    WORKFLOW_ID: execution.runId,
    ARCHON_NODE_EXECUTION: nodeExecutionEnvValue(execution),
    ARCHON_CLI_COMMAND: cliCommand ?? '',
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
      typedArtifactsFile: '',
      nodeExecution: null,
      inputEnvKeys: [],
    })
  )
);
