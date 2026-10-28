import { scriptInvocation } from '../../script-invocation';
import { bashInvocation } from '../../bash-invocation';
import { mkdir } from 'node:fs/promises';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { certifyExecOutput } from '../../dag/nodes/exec/exec-output';
import { discoverScriptsForCwd } from '../../script-discovery';
import {
  formatHostSpawnFailure,
  formatSubprocessFailure,
  isInlineScript,
} from '../../executor-shared';
import {
  hostSpawnFailure,
  isSubprocessTimeout,
  redactSubprocessError,
  type RawSubprocessRejection,
} from '../../subprocess';
import { collectCredentialValues } from '@archon/paths/credential-redaction';
import { assertWorkflowSourceIntegrity } from '../../workflow-source';
import { buildExecNodeEnvironment } from '../../exec-environment';
import type { NodeExecutionMetadata } from '../../schemas/node-execution';
import type { ExecNode } from '../../schemas';
import type { DryRunContext } from '../context';

export async function executeCodeNode(
  node: ExecNode,
  code: string,
  ctx: DryRunContext,
  /** The executor's own `INPUTS_<UPPER_SNAKE>` bag: run, composed and node-local inputs. */
  inputEnv: NodeJS.ProcessEnv,
  execution?: NodeExecutionMetadata
): Promise<ReturnType<typeof certifyExecOutput> | { error: string }> {
  try {
    const { command, args, input } = await resolveCodeInvocation(node, code, ctx);
    // The executor pre-creates the artifacts dir it advertises; the simulator honors
    // the same contract (#2617). Idempotent, and only reached when code executes, so
    // a pure-stub dry run creates no directory.
    await mkdir(ctx.artifactsDir, { recursive: true });
    await mkdir(ctx.stateDir, { recursive: true });
    const env = {
      ...process.env,
      ...ctx.envVars,
      PYTHONDONTWRITEBYTECODE: '1',
      PWD: ctx.execWorkspace,
      OLDPWD: ctx.execWorkspace,
      ...inputEnv,
      ...buildExecNodeEnvironment({
        artifactsDir: ctx.artifactsDir,
        stateDir: ctx.stateDir,
        logDir: ctx.logDir,
        workflowId: 'dry-run',
        baseBranch: 'dry-run-base',
        userMessage: ctx.userMessage,
        loopUserInput: '',
        loopPrevOutput: '',
        rejectionReason: '',
        issueContext: '',
        // No artifacts are written in a dry run, so there is no listing to point at.
        typedArtifactsFile: '',
        nodeExecution: execution ?? null,
        inputEnvKeys: Object.keys(inputEnv),
      }),
    };
    const credentialValues = collectCredentialValues(
      env,
      ctx.protectedEnvKeys,
      ctx.protectedCredentialValues
    );
    let result: Awaited<ReturnType<typeof execFileAsync>>;
    try {
      result = await execFileAsync(command, args, {
        input,
        cwd: ctx.execWorkspace,
        timeout: node.timeout ?? 300_000,
        env,
      });
    } catch (error) {
      const err = redactSubprocessError(error as RawSubprocessRejection, credentialValues);
      return { error: codeNodeFailure(node, command, err) };
    }
    // The real run's gate, so a fixture cannot pass a node whose stdout the engine would reject.
    return certifyExecOutput(node, result.stdout.replace(/\n$/, ''), credentialValues);
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function codeNodeFailure(node: ExecNode, command: string, err: RawSubprocessRejection): string {
  const label = `${node.runtime === 'sh' ? 'Bash' : 'Script'} node '${node.id}'`;
  if (isSubprocessTimeout(err))
    return `${label} timed out after ${String(node.timeout ?? 300_000)}ms`;
  const spawnFailure = hostSpawnFailure({ kind: 'host' }, err);
  const spawnMessage = formatHostSpawnFailure(spawnFailure, node.runtime, command, label);
  if (spawnMessage !== undefined) return spawnMessage;
  const { userMessage } = formatSubprocessFailure(err, label);
  return err.signal ? `${userMessage} [signal ${err.signal}]` : userMessage;
}

async function resolveCodeInvocation(
  node: ExecNode,
  code: string,
  ctx: DryRunContext
): Promise<{ command: string; args: string[]; input?: string }> {
  if (node.runtime === 'sh') {
    return { command: resolveBashPath(), ...bashInvocation(code) };
  }
  if (isInlineScript(code)) {
    return scriptInvocation(node.runtime, { kind: 'inline', code }, node.deps);
  }
  await assertWorkflowSourceIntegrity(ctx.sourceRoots);
  const script = (await discoverScriptsForCwd(ctx.cwd, ctx.sourceRoots)).get(code);
  if (!script) throw new Error(`Named script '${code}' was not found`);
  return scriptInvocation(script.runtime, { kind: 'file', path: script.path }, node.deps);
}
