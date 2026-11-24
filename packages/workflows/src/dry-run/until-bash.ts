import { execFileAsync, resolveBashPath } from '@archon/git';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { bashInvocation } from '../bash-invocation';
import type { LoopBodyScope } from '../dag/loop-scope';
import { inputEnvVars } from '../dag/references';
import { formatHostSpawnFailure, formatSubprocessFailure } from '../executor-shared';
import type { LoopNode, LoopGroupNode, NodeOutput } from '../schemas';
import {
  hostSpawnFailure,
  isSubprocessTimeout,
  redactSubprocessError,
  type RawSubprocessRejection,
} from '../subprocess';
import { bindingShellContext, resolveText, type DryRunContext } from './context';
import { writeDryRunInvocationListings } from './invocation-listings';
import { loopIterationCompletes, type SimulatedCompletion } from './loop-completion';
import { prepareCodeExecution } from './nodes/exec';

export async function evaluateLoopCompletion(
  node: LoopNode | LoopGroupNode,
  hydrated: { output: string; structuredOutput?: unknown },
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  previous = '',
  loopBodyScopes: readonly LoopBodyScope[] = ctx.loopBodyScopes
): Promise<SimulatedCompletion> {
  const control = node.kind === 'loop' ? node.loop : node.loop_group;
  const completion = loopIterationCompletes(
    control,
    hydrated,
    ctx.execCode ? 'incomplete' : 'assumed'
  );
  if (completion.kind !== 'incomplete' || !ctx.execCode || control.until_bash === undefined)
    return completion;
  const label = `Node '${node.id}' ${node.kind === 'loop' ? 'loop' : 'loop_group'}.until_bash`;
  const timeout = node.timeout ?? 300_000;
  let credentialValues = collectCredentialValues(
    { ...process.env, ...ctx.envVars },
    ctx.protectedEnvKeys,
    ctx.protectedCredentialValues
  );
  try {
    const listings = await writeDryRunInvocationListings(ctx);
    const { env, credentialValues: preparedCredentials } = await prepareCodeExecution(
      ctx,
      inputEnvVars(node, { ...bindingShellContext(ctx, outputs), loopBodyScopes }, ctx.inputs),
      undefined,
      { ...listings, loopPrevOutput: previous }
    );
    credentialValues = preparedCredentials;
    const code = resolveText(control.until_bash, ctx, outputs, 'shell', previous, ctx.inputs, {
      listings,
      requiredContext: {
        consumerId: node.id,
        field: node.kind === 'loop' ? 'loop.until_bash' : 'loop_group.until_bash',
      },
      loopBodyScopes,
    });
    const command = resolveBashPath();
    const invocation = bashInvocation(code);
    return await executeProbe(
      command,
      invocation,
      ctx.execWorkspace,
      env,
      timeout,
      label,
      credentialValues
    );
  } catch (error) {
    throw new Error(
      `${label} failed: ${redactCredentialValues(error instanceof Error ? error.message : String(error), credentialValues)}`
    );
  }
}

async function executeProbe(
  command: string,
  invocation: ReturnType<typeof bashInvocation>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  label: string,
  credentialValues: readonly string[]
): Promise<SimulatedCompletion> {
  try {
    await execFileAsync(command, invocation.args, { input: invocation.input, cwd, env, timeout });
    return { kind: 'bash' };
  } catch (error) {
    const failure = redactSubprocessError(error as RawSubprocessRejection, credentialValues);
    if (isSubprocessTimeout(failure))
      throw new Error(`${label} timed out after ${String(timeout)}ms`);
    const spawnMessage = formatHostSpawnFailure(
      hostSpawnFailure({ kind: 'host' }, failure),
      'sh',
      command,
      label
    );
    if (spawnMessage !== undefined) throw new Error(spawnMessage);
    if (
      typeof failure.code === 'number' &&
      !failure.signal &&
      !failure.cancelled &&
      !failure.treeSurvived
    )
      return { kind: 'incomplete' };
    const { userMessage } = formatSubprocessFailure(failure, label);
    throw new Error(failure.signal ? `${userMessage} [signal ${failure.signal}]` : userMessage);
  }
}
