import { bashInvocation } from '../../../bash-invocation';
import {
  hostSpawnFailure,
  isSubprocessTimeout,
  type RawSubprocessRejection,
} from '../../../subprocess';
import { finishNodeExecution } from '../../../node-execution';
import { type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import { resolveBashPath } from '@archon/git';
import type { ExecNode } from '../../../schemas';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { currentAdoptedRunDir, substituteWorkflowVariables } from '../../../workflow-variables';
import { formatHostSpawnFailure, formatSubprocessFailure } from '../../../executor-shared';
import { safeSendMessage, type SendMessageContext } from '../../../platform-messages';
import { getLog } from '../../log';
import { beginExecution, observeNodeCheckout, type RunLayersContext } from '../../run-context';
import { nodeTemplateReferences, buildNodeShellEnvironment } from '../../references';
import { formatPersistedNodeOutput } from '../../node-output';
import { runSubprocessUntilRunStops } from '../../run-control';
import {
  ExecOutputContractError,
  certifyExecOutput,
  assertExecArtifactPointers,
  recordExecTimeoutSkip,
} from './exec-output';

/**
 * Execute a bash (shell script) DAG node.
 * Runs the script via `bash -c`, captures stdout as node output.
 * No AI session is created — bash nodes are free/deterministic.
 */
export async function executeBashNode(
  ctx: RunLayersContext,
  node: ExecNode
): Promise<NodeExecutionResult> {
  const { envVars, protectedEnvKeys, protectedCredentialValues } = ctx.config;
  const { bodyLoopUserInput: loopUserInput = '' } = ctx;
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    issueContext,
    execContext,
  } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, { checkoutStart: await observeNodeCheckout(ctx) }),
    diagnostics: { ...(iteration !== undefined ? { iteration } : {}) },
  };

  getLog().info({ nodeId: node.id, type: 'bash' }, 'dag_node_started');

  await recordNodeState({ store: deps.store, logDir }, execution);

  // Fresh per call: executeBashNode runs once per retry attempt, so each attempt
  // observes the artifacts published before IT. A materialization failure propagates
  // to the retry/dispatch boundary as an explicit node provisioning error.
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  const { prompt: finalScript } = substituteWorkflowVariables(
    node.script,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext,
    undefined,
    undefined,
    undefined,
    {
      shellSafe: true,
      stateDir,
      typedArtifactsFile,
      references: nodeTemplateReferences(node.script, ctx, 'shell', { artifactsDir }),
    }
  );

  // Archon-managed env only — runSubprocess adds the host env for host runs and
  // delivers ONLY this bag into the container (host process.env never crosses).
  const subprocessEnv: NodeJS.ProcessEnv = buildNodeShellEnvironment(node, ctx, envVars, {
    artifactsDir,
    stateDir,
    logDir,
    workflowId: workflowRun.id,
    baseBranch,
    userMessage: workflowRun.user_message,
    loopUserInput,
    loopPrevOutput: '',
    rejectionReason: '',
    issueContext,
    adoptedRunDir: currentAdoptedRunDir(),
    typedArtifactsFile,
    nodeExecution: execution,
  });

  const bashPath = resolveBashPath();
  let certified: ReturnType<typeof certifyExecOutput>;
  try {
    const invocation = bashInvocation(finalScript);
    const { stdout, stderr, credentialValues } = await runSubprocessUntilRunStops(
      deps.store,
      workflowRun.id,
      node.id,
      execContext,
      bashPath,
      invocation.args,
      {
        input: invocation.input,
        cwd,
        timeout: node.timeout,
        endTreeOnTimeout: true,
        env: subprocessEnv,
        protectedEnvKeys,
        protectedCredentialValues,
        retention: {
          logDir,
          workflowRunId: workflowRun.id,
          nodeId: node.id,
          label: '<bash>',
        },
      }
    );

    // Trim trailing newline from stdout (common shell behavior)
    const trimmedStdout = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'bash_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Bash node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    // A declared output_format makes this node's stdout a contract: parse it, validate it,
    // and hand downstream consumers the canonical document instead of raw text (#2453).
    // Runs AFTER the stderr relay so a contract failure never swallows the script's own
    // diagnostics; it throws an ExecOutputContractError, handled by this function's catch.
    certified = certifyExecOutput(node, trimmedStdout, credentialValues);
    await assertExecArtifactPointers(workflowRun, node, certified.structuredOutput);
  } catch (error) {
    return recordBashFailure(ctx, node, execution, bashPath, error);
  }

  const output = certified.output;
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const persistedOutput = formatPersistedNodeOutput(output, artifactsDir);

  return recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      execution,
      { status: 'completed' },
      {
        durationMs: duration,
        output: {
          text: output,
          structured: certified.structuredOutput,
          declaredOutputPaths: certified.declaredOutputPaths,
          persisted: {
            text: persistedOutput.nodeOutput,
            truncated: persistedOutput.truncated,
            originalBytes: persistedOutput.originalBytes,
            spillPath: persistedOutput.spillPath,
          },
        },
      }
    )
  );
}

function bashFailureMessage(
  err: RawSubprocessRejection,
  node: ExecNode,
  contractFailure: boolean,
  isTimeout: boolean,
  spawnMessage: string | undefined,
  fallback: string
): string {
  const label = `Bash node '${node.id}'`;
  if (contractFailure) {
    return err.message;
  }
  if (isTimeout) {
    return `${label} timed out after ${String(node.timeout)}ms`;
  }
  if (err.treeSurvived) {
    return `${label} failed: ${err.message}`;
  }
  if (err.cancelled) {
    return `${label} cancelled`;
  }
  if (spawnMessage !== undefined) {
    return spawnMessage;
  }
  return fallback;
}

async function recordBashFailure(
  ctx: RunLayersContext,
  node: ExecNode,
  execution: NodeExecutionRecord,
  bashPath: string,
  error: unknown
): Promise<NodeExecutionResult> {
  const err = error as RawSubprocessRejection;
  // A contract failure (#2453) is Archon's own diagnosis of stdout, not a subprocess
  // rejection. Report it verbatim and keep it outside subprocess classification.
  const contractFailure = error instanceof ExecOutputContractError;
  const isTimeout = !contractFailure && isSubprocessTimeout(err);
  if (isTimeout && node.on_timeout === 'skip') {
    return recordExecTimeoutSkip(ctx, execution);
  }
  const label = `Bash node '${node.id}'`;
  // Always run the formatter so logs get sanitized fields regardless of which
  // user-facing branch we end up in — the timeout message also contains the
  // full `Command failed: bash -c <body>` line and would otherwise leak.
  const formatted = formatSubprocessFailure(err, label);
  const spawnMessage = formatHostSpawnFailure(
    hostSpawnFailure(ctx.execContext, err),
    'sh',
    bashPath,
    label
  );
  const errorMsg = bashFailureMessage(
    err,
    node,
    contractFailure,
    isTimeout,
    spawnMessage,
    formatted.userMessage
  );

  getLog().error(
    { ...formatted.logFields, nodeId: node.id, nodeType: 'bash', isTimeout },
    'dag_node_failed'
  );

  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      execution,
      {
        status: 'failed',
        error: errorMsg,
        failureKind: contractFailure
          ? 'output_contract'
          : err.cancelled
            ? 'cancelled'
            : isTimeout
              ? 'timeout'
              : 'exec_failed',
        ...(contractFailure ? { retryable: false as const } : {}),
      },
      { output: { text: '' } }
    )
  );
}
