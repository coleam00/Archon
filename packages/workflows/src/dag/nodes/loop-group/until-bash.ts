import { bashInvocation } from '../../../bash-invocation';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import { currentAdoptedRunDir } from '../../../workflow-variables';
import { getLog } from '../../log';
import { buildNodeShellEnvironment } from '../../references';
import { runSubprocessUntilRunStops } from '../../run-control';
import type { LoopGroupBodyResult, LoopGroupRun } from './loop-group-state';

/**
 * Run the group's until_bash for one iteration: exit 0 completes it, any other exit code
 * keeps looping. `script` is substituted inside the try, so a substitution fault takes the
 * same unexpected-error path as a subprocess fault.
 */
export async function runGroupUntilBash(
  run: LoopGroupRun,
  iteration: number,
  bash: {
    path: string;
    script: () => string;
    loopUserInput: string;
    loopPrevOutput: string;
    typedArtifactsFile: string;
  }
): Promise<boolean | LoopGroupBodyResult> {
  const { ctx, node } = run;
  const { workflowRun, artifactsDir, stateDir, logDir, baseBranch, config } = ctx;
  try {
    const invocation = bashInvocation(bash.script());
    await runSubprocessUntilRunStops(
      ctx.deps.store,
      workflowRun.id,
      node.id,
      ctx.execContext,
      bash.path,
      invocation.args,
      {
        input: invocation.input,
        cwd: ctx.cwd,
        timeout: node.timeout,
        protectedEnvKeys: config.protectedEnvKeys,
        protectedCredentialValues: config.protectedCredentialValues,
        retention: {
          logDir,
          workflowRunId: workflowRun.id,
          nodeId: `${node.id}-iteration-${String(iteration)}`,
          label: '<until_bash>',
        },
        env: buildNodeShellEnvironment(node, ctx, config.envVars, {
          artifactsDir,
          stateDir,
          logDir,
          workflowId: workflowRun.id,
          baseBranch,
          userMessage: workflowRun.user_message,
          loopUserInput: bash.loopUserInput,
          loopPrevOutput: bash.loopPrevOutput,
          rejectionReason: '',
          issueContext: ctx.issueContext,
          adoptedRunDir: currentAdoptedRunDir(),
          typedArtifactsFile: bash.typedArtifactsFile,
          nodeExecution: ctx.currentExecution ?? null,
        }),
      }
    );
    return true;
  } catch (e) {
    return untilBashRejected(run, iteration, e as RawSubprocessRejection, bash.path);
  }
}

function untilBashRejected(
  run: LoopGroupRun,
  iteration: number,
  bashErr: RawSubprocessRejection,
  bashPath: string
): false | LoopGroupBodyResult {
  const { node } = run;
  if (bashErr.cancelled) {
    return {
      state: 'failed',
      output: '',
      error: bashErr.message,
      failureKind: 'cancelled',
      ...run.progress.usage,
      loopIterations: run.progress.lastStartedIteration,
    };
  }
  // System-level errors (ENOENT/EACCES/ENOTDIR) mean the bash binary itself
  // is unreachable — looping forever on bashComplete=false is wrong. Throw
  // out of the group with a clear actionable error instead (mirrors
  // executeLoopNode's until_bash handling).
  if (hostSpawnFailure(run.ctx.execContext, bashErr) !== undefined) {
    getLog().error({ err: bashErr, nodeId: node.id, iteration }, 'loop_group.until_bash_failed');
    throw new Error(
      `Loop group '${node.id}' until_bash failed: cannot execute bash at ` +
        `'${bashPath}' (${bashErr.code}). Set ARCHON_BASH_PATH if Git Bash ` +
        'is installed elsewhere.'
    );
  }
  // Non-exec errors (template substitution, etc.) have no err.code — they
  // should halt the group, not silently re-iterate.
  if (typeof bashErr.code !== 'number') {
    getLog().error(
      { err: bashErr, nodeId: node.id, iteration },
      'loop_group.until_bash_unexpected_error'
    );
    throw bashErr;
  }
  // Numeric exit code from the bash script = condition not met yet, keep looping.
  return false;
}
