import { resolveBashPath } from '@archon/git';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { bashInvocation } from '../bash-invocation';
import { loopPrevRefToken, type LoopBodyScope } from '../dag/loop-scope';
import { inputEnvVars, nodeOutputRefToken } from '../dag/references';
import { substituteTemplate, templateToken, type TemplateToken } from '../output-ref';
import { formatHostSpawnFailure, formatSubprocessFailure } from '../executor-shared';
import type { LoopNode, LoopGroupNode, NodeOutput } from '../schemas';
import {
  hostSpawnFailure,
  execOwnedProcessGroup,
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
  hydrated: NodeOutput,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  previous?: NodeOutput,
  loopBodyScopes: readonly LoopBodyScope[] = ctx.loopBodyScopes
): Promise<SimulatedCompletion> {
  const control = node.kind === 'loop' ? node.loop : node.loop_group;
  const completion = loopIterationCompletes(
    control,
    hydrated,
    ctx.execCode ? 'incomplete' : 'assumed'
  );
  if (
    ctx.execCode &&
    control.until_bash !== undefined &&
    ctx.generatedOutputs.has(hydrated) &&
    (completion.kind === 'field' || completion.kind === 'signal')
  )
    throw new Error(
      `Node '${node.id}' completion requires an authored or executed output, not a generated placeholder`
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
    assertProbeOutputs(control.until_bash, outputs, loopBodyScopes, previous, ctx);
    const previousText = previous?.output ?? '';
    const listings = await writeDryRunInvocationListings(ctx);
    const { env, credentialValues: preparedCredentials } = await prepareCodeExecution(
      ctx,
      inputEnvVars(node, { ...bindingShellContext(ctx, outputs), loopBodyScopes }, ctx.inputs),
      undefined,
      { ...listings, loopPrevOutput: previousText }
    );
    credentialValues = preparedCredentials;
    const code = resolveText(control.until_bash, ctx, outputs, 'shell', previousText, ctx.inputs, {
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

function assertProbeOutputs(
  code: string,
  outputs: Map<string, NodeOutput>,
  scopes: readonly LoopBodyScope[],
  previous: NodeOutput | undefined,
  ctx: DryRunContext
): void {
  const requireAuthored = (output: NodeOutput | undefined): void => {
    if (output !== undefined && ctx.generatedOutputs.has(output))
      throw new Error(
        'Completion probes require an authored stub or executed output, not a generated placeholder'
      );
  };
  const guarded = (
    token: TemplateToken,
    sources: Map<string, NodeOutput> | undefined
  ): TemplateToken => ({
    pattern: token.pattern,
    resolve: match => {
      const resolved = token.resolve(match);
      if (resolved !== undefined) requireAuthored(sources?.get(match[1]));
      return resolved;
    },
  });
  substituteTemplate(code, [
    ...scopes.map(scope => guarded(loopPrevRefToken(scope, false), scope.loopPrevOutputs)),
    guarded(nodeOutputRefToken(outputs, false), outputs),
    templateToken(String.raw`\$(?:LOOP_PREV_OUTPUT\b|\{LOOP_PREV_OUTPUT\})`, () => {
      requireAuthored(previous);
      return '';
    }),
    templateToken(
      String.raw`\$(?:(?:TYPED_ARTIFACTS_FILE|NODE_OUTCOMES_FILE)\b|\{(?:TYPED_ARTIFACTS_FILE|NODE_OUTCOMES_FILE)\})`,
      () => {
        for (const output of outputs.values()) requireAuthored(output);
        return '';
      }
    ),
  ]);
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
    await execOwnedProcessGroup(command, invocation.args, {
      input: invocation.input,
      cwd,
      env,
      timeout,
      node: { recorder: undefined, endTreeOnTimeout: true },
    });
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
