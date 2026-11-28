import { resolveBashPath } from '@archon/git';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { bashInvocation } from '../bash-invocation';
import { type LoopBodyScope } from '../dag/loop-scope';
import { inputEnvVars, type RequiredOutputRefContext } from '../dag/references';
import { readComposedMeta } from '../compiled-command';
import { substituteTemplate, templateToken } from '../output-ref';
import { formatHostSpawnFailure, formatSubprocessFailure } from '../executor-shared';
import { type LoopNode, type LoopGroupNode, type NodeOutput } from '../schemas';
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
import {
  assertAuthoredBindings,
  assertAuthoredOutput,
  authoredOutputReferences,
} from './output-provenance';

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
    const inputEnv = inputEnvVars(
      node,
      { ...bindingShellContext(ctx, outputs), loopBodyScopes },
      ctx.inputs
    );
    const { listings, previousText, requiredContext } = await prepareProbeData(
      node,
      hydrated,
      outputs,
      ctx,
      previous,
      loopBodyScopes,
      control.until_bash
    );
    const { env, credentialValues: preparedCredentials } = await prepareCodeExecution(
      ctx,
      inputEnv,
      undefined,
      { ...listings, loopPrevOutput: previousText }
    );
    credentialValues = preparedCredentials;
    const code = resolveText(control.until_bash, ctx, outputs, 'shell', previousText, ctx.inputs, {
      listings,
      requiredContext,
      loopBodyScopes,
    });
    const command = resolveBashPath();
    const invocation = bashInvocation(code);
    return await executeProbe(command, invocation, ctx, env, timeout, label, credentialValues);
  } catch (error) {
    throw new Error(
      `${label} failed: ${redactCredentialValues(error instanceof Error ? error.message : String(error), credentialValues)}`
    );
  }
}

async function prepareProbeData(
  node: LoopNode | LoopGroupNode,
  hydrated: NodeOutput,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  previous: NodeOutput | undefined,
  loopBodyScopes: readonly LoopBodyScope[],
  code: string
) {
  const requiredContext: RequiredOutputRefContext = {
    consumerId: node.id,
    field: node.kind === 'loop' ? 'loop.until_bash' : 'loop_group.until_bash',
  };
  const observationsAvailable = [hydrated, ...outputs.values()].every(
    output => !ctx.generatedOutputs.has(output)
  );
  assertProbeOutputs(
    node,
    code,
    outputs,
    loopBodyScopes,
    previous,
    ctx,
    requiredContext,
    observationsAvailable
  );
  // Shell and child-process environment reads are independent of template spelling.
  const previousText =
    previous !== undefined && !ctx.generatedOutputs.has(previous) ? previous.output : '';
  const listings = observationsAvailable
    ? await writeDryRunInvocationListings(ctx)
    : { typedArtifactsFile: '', nodeOutcomesFile: '' };
  return { listings, previousText, requiredContext };
}

function assertProbeOutputs(
  node: LoopNode | LoopGroupNode,
  code: string,
  outputs: Map<string, NodeOutput>,
  scopes: readonly LoopBodyScope[],
  previous: NodeOutput | undefined,
  ctx: DryRunContext,
  requiredContext: RequiredOutputRefContext,
  observationsAvailable: boolean
): void {
  const references = authoredOutputReferences(
    outputs,
    scopes,
    ctx.generatedOutputs,
    requiredContext
  );
  assertAuthoredBindings(Object.values(readComposedMeta(node)?.inputs ?? {}), outputs, references);
  substituteTemplate(code, [
    ...references.current,
    templateToken(String.raw`\$(?:LOOP_PREV_OUTPUT\b|\{LOOP_PREV_OUTPUT\})`, () => {
      assertAuthoredOutput(previous, ctx.generatedOutputs);
      return '';
    }),
    templateToken(
      String.raw`\$(?:(?:TYPED_ARTIFACTS_FILE|NODE_OUTCOMES_FILE)\b|\{(?:TYPED_ARTIFACTS_FILE|NODE_OUTCOMES_FILE)\})`,
      () => {
        if (!observationsAvailable)
          throw new Error('Completion probe observations require authored or executed outputs');
        return '';
      }
    ),
  ]);
}

async function executeProbe(
  command: string,
  invocation: ReturnType<typeof bashInvocation>,
  ctx: DryRunContext,
  env: NodeJS.ProcessEnv,
  timeout: number,
  label: string,
  credentialValues: readonly string[]
): Promise<SimulatedCompletion> {
  try {
    await execOwnedProcessGroup(command, invocation.args, {
      input: invocation.input,
      cwd: ctx.execWorkspace,
      env,
      timeout,
      // Windows has no POSIX lifeline; retain its existing whole-tree timeout mode.
      node:
        process.platform === 'win32' ? { recorder: undefined, endTreeOnTimeout: true } : undefined,
    });
    return { kind: 'bash' };
  } catch (error) {
    const failure = redactSubprocessError(error as RawSubprocessRejection, credentialValues);
    if (failure.treeSurvived) ctx.survivingProbeTree = true;
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
