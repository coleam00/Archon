import { mkdir } from 'node:fs/promises';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { certifyExecOutput } from '../../dag/nodes/exec/exec-output';
import { discoverScriptsForCwd } from '../../script-discovery';
import { isInlineScript } from '../../executor-shared';
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
    let command: string;
    let args: string[];
    if (node.runtime === 'sh') {
      command = resolveBashPath();
      args = ['-c', code];
    } else if (isInlineScript(code)) {
      if (node.runtime === 'bun') {
        command = 'bun';
        args = ['--no-env-file', '-e', code];
      } else {
        command = 'uv';
        args = ['run', ...(node.deps ?? []).flatMap(dep => ['--with', dep]), 'python', '-c', code];
      }
    } else {
      await assertWorkflowSourceIntegrity(ctx.sourceRoots);
      const script = (await discoverScriptsForCwd(ctx.cwd, ctx.sourceRoots)).get(code);
      if (!script) return { error: `Named script '${code}' was not found` };
      command = script.runtime === 'bun' ? 'bun' : 'uv';
      args =
        script.runtime === 'bun'
          ? ['--no-env-file', 'run', script.path]
          : ['run', ...(node.deps ?? []).flatMap(dep => ['--with', dep]), script.path];
    }
    // The executor pre-creates the artifacts dir it advertises; the simulator honors
    // the same contract (#2617). Idempotent, and only reached when code executes, so
    // a pure-stub dry run creates no directory.
    await mkdir(ctx.artifactsDir, { recursive: true });
    await mkdir(ctx.stateDir, { recursive: true });
    const result = await execFileAsync(command, args, {
      cwd: ctx.execWorkspace,
      timeout: node.timeout ?? 300_000,
      env: {
        ...process.env,
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
        }),
      },
    });
    // The real run's gate, so a fixture cannot pass a node whose stdout the engine would reject.
    // The simulator has no credential set to redact from the quoted stdout.
    return certifyExecOutput(node, result.stdout.replace(/\n$/, ''), []);
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return { error: err.stderr?.trim() || err.message };
  }
}
