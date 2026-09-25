import type { NodeExecutionMetadata } from './schemas/node-execution';

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
    // The listing path, delivered like the other engine-reserved keys: configured
    // project env and node bindings spread before this bag, so neither can shadow it.
    TYPED_ARTIFACTS_FILE: context.typedArtifactsFile,
    ARCHON_NODE_EXECUTION:
      context.nodeExecution === null
        ? ''
        : JSON.stringify({
            runId: context.nodeExecution.runId,
            path: context.nodeExecution.path,
            invocation: context.nodeExecution.invocation,
            attempt: context.nodeExecution.attempt,
          }),
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
    })
  )
);
