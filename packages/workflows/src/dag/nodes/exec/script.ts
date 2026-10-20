import {
  hostSpawnFailure,
  isSubprocessTimeout,
  type RawSubprocessRejection,
} from '../../../subprocess';
import { finishNodeExecution } from '../../../node-execution';
import { type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import { readFile } from 'node:fs/promises';
import { discoverScriptsForCwd } from '../../../script-discovery';
import {
  capturedSourceReadGuard,
  assertCapturedFilesPresent,
  isSourceReadFailure,
} from '../../../workflow-source';
import type { ExecNode } from '../../../schemas';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { currentAdoptedRunDir, substituteWorkflowVariables } from '../../../workflow-variables';
import { isInlineScript, formatSubprocessFailure } from '../../../executor-shared';
import { safeSendMessage, type SendMessageContext } from '../../../platform-messages';
import { getLog } from '../../log';
import { assertNodeSourceReadable, RunSourceUnreadableError } from '../../node-source';
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
 * Execute a script (TypeScript via bun or Python via uv) DAG node.
 * Supports both inline code snippets and named scripts discovered from .archon/scripts/.
 * stdout is captured and trimmed as the node output; stderr is logged as a warning.
 */
export async function executeScriptNode(
  ctx: RunLayersContext,
  node: ExecNode,
  reserveBudget: () => Promise<void>
): Promise<NodeExecutionResult> {
  const { envVars, protectedEnvKeys, protectedCredentialValues } = ctx.config;
  const { stepNamePrefix, bodyLoopUserInput: loopUserInput = '' } = ctx;
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
    workflowSourceRoots,
  } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  // Resolve before deciding whether this is inline or filesystem-backed: substitutions
  // can turn the authored field into either form. A named source is checked outside the
  // deterministic retry classifier, so an integrity failure cannot consume retries.
  // User-controlled variables stay in subprocess env instead of being spliced into
  // TS/Python source; strict node-output references keep raw substitution (#2115).
  // Fresh per call, same as executeBashNode: one attempt, one observation.
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
      references: nodeTemplateReferences(node.script, ctx, 'script'),
    }
  );
  const verifiedScriptFiles = !isInlineScript(finalScript)
    ? await assertNodeSourceReadable(workflowSourceRoots, stepName)
    : undefined;
  const namedScripts = isInlineScript(finalScript)
    ? undefined
    : await discoverScriptsForCwd(
        cwd,
        workflowSourceRoots,
        new Set([finalScript]),
        capturedSourceReadGuard(verifiedScriptFiles)
      )
        .then(async scripts => {
          await assertCapturedFilesPresent(verifiedScriptFiles);
          const selected = scripts.get(finalScript);
          if (selected) await readFile(selected.path);
          return scripts;
        })
        .catch(error => {
          if (isSourceReadFailure(error, verifiedScriptFiles))
            throw new RunSourceUnreadableError(stepName, error);
          return error instanceof Error ? error : new Error(String(error));
        });
  await reserveBudget();
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, { checkoutStart: await observeNodeCheckout(ctx) }),
    diagnostics: { ...(iteration !== undefined ? { iteration } : {}) },
  };

  getLog().info({ nodeId: node.id, type: 'script', runtime: node.runtime }, 'dag_node_started');

  await recordNodeState({ store: deps.store, logDir }, execution);

  // Archon-managed env only — runSubprocess adds the host env for host runs and
  // delivers ONLY this bag into the container (host process.env never crosses).
  // User-controlled values ride env vars (never spliced into source) — the
  // sanctioned injection-safe channel, matching executeBashNode (#2115).
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...buildNodeShellEnvironment(node, ctx, envVars, {
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
    }),
    // Named Python scripts run from the frozen capture, and CPython writes bytecode
    // caches beside any module it imports. A cache landing in the capture would change
    // it under the run and fail the next integrity check with a misleading message.
    // Inline scripts have no siblings, so the flag costs them nothing.
    PYTHONDONTWRITEBYTECODE: '1',
  };

  // Build the command and args based on runtime and inline vs named
  let cmd = '';
  let args: string[] = [];

  const nodeDeps = node.deps ?? [];

  if (isInlineScript(finalScript)) {
    // Inline code execution
    if (node.runtime === 'bun') {
      cmd = 'bun';
      // --no-env-file prevents Bun from auto-loading .env from the execution
      // cwd (the target repo). Without this, repo .env leaks into the script
      // subprocess despite Archon's parent process cleanup.
      args = ['--no-env-file', '-e', finalScript];
    } else {
      // uv run --with dep1 --with dep2 python -c <code>
      cmd = 'uv';
      const withFlags = nodeDeps.flatMap(dep => ['--with', dep]);
      args = ['run', ...withFlags, 'python', '-c', finalScript];
    }
  } else {
    // Named script — look up across repo and home scopes.
    // Precedence: <cwd>/.archon/scripts/ > ~/.archon/scripts/ (repo wins).
    if (namedScripts instanceof Error) {
      const err = namedScripts;
      const errorMsg = `Script node '${node.id}': failed to discover scripts — ${err.message}`;
      getLog().error({ err, nodeId: node.id, cwd }, 'script_discovery_failed');
      await safeSendMessage(platform, conversationId, errorMsg, nodeContext);

      return recordNodeState(
        { store: deps.store, logDir },
        finishNodeExecution(
          execution,
          { status: 'failed', error: errorMsg, failureKind: 'config' },
          { output: { text: '' } }
        )
      );
    }
    const scriptDef = namedScripts?.get(finalScript);

    if (!scriptDef) {
      const errorMsg = `Script node '${node.id}': named script '${finalScript}' not found in .archon/scripts/ or ~/.archon/scripts/`;
      getLog().error({ nodeId: node.id, scriptName: finalScript }, 'script_not_found');
      await safeSendMessage(platform, conversationId, errorMsg, nodeContext);

      return recordNodeState(
        { store: deps.store, logDir },
        finishNodeExecution(
          execution,
          { status: 'failed', error: errorMsg, failureKind: 'config' },
          { output: { text: '' } }
        )
      );
    }

    // Use scriptDef.runtime (canonical source) instead of re-deriving from extension
    if (scriptDef.runtime === 'uv') {
      cmd = 'uv';
      const withFlags = nodeDeps.flatMap(dep => ['--with', dep]);
      args = ['run', ...withFlags, scriptDef.path];
    } else {
      cmd = 'bun';
      args = ['--no-env-file', 'run', scriptDef.path];
    }
  }

  // After dispatch, a rejection may follow user side effects; source recovery must not
  // replace that outcome. Recheck while execution is still known not to have started.
  const selected = namedScripts instanceof Map ? namedScripts.get(finalScript) : undefined;
  if (selected) {
    try {
      await Promise.all([...(verifiedScriptFiles ?? [selected.path])].map(path => readFile(path)));
    } catch (error) {
      if (isSourceReadFailure(error, verifiedScriptFiles))
        throw new RunSourceUnreadableError(stepName, error);
      throw error;
    }
  }

  let certified: ReturnType<typeof certifyExecOutput>;
  try {
    const { stdout, stderr, credentialValues } = await runSubprocessUntilRunStops(
      deps.store,
      workflowRun.id,
      node.id,
      execContext,
      cmd,
      args,
      {
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
          label: '<script>',
        },
      }
    );

    // Trim trailing newline from stdout (common shell behavior)
    const trimmedStdout = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'script_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Script node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    // Identical certification to executeBashNode (#2453): a declared output_format makes
    // this node's stdout a contract, and the canonical document replaces the raw text.
    certified = certifyExecOutput(node, trimmedStdout, credentialValues);
    await assertExecArtifactPointers(workflowRun, node, certified.structuredOutput);
  } catch (error) {
    if (error instanceof RunSourceUnreadableError) throw error;
    const err = error as RawSubprocessRejection;
    // See executeBashNode: a contract failure (#2453) stays outside subprocess classification.
    const contractFailure = error instanceof ExecOutputContractError;
    const isTimeout = !contractFailure && isSubprocessTimeout(err);
    if (isTimeout && node.on_timeout === 'skip') {
      return recordExecTimeoutSkip(ctx, execution);
    }
    const label = `Script node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in — the timeout message also contains the
    // full `Command failed: bun -e <body>` line and would otherwise leak.
    const formatted = formatSubprocessFailure(err, label);
    const spawnFailure = hostSpawnFailure(execContext, err);
    let errorMsg: string;
    if (contractFailure) {
      errorMsg = err.message;
    } else if (isTimeout) {
      errorMsg = `${label} timed out after ${String(node.timeout)}ms`;
    } else if (err.treeSurvived) {
      errorMsg = `${label} failed: ${err.message}`;
    } else if (err.cancelled) {
      errorMsg = `${label} cancelled`;
    } else if (spawnFailure === 'ENOENT') {
      errorMsg = `${label} failed: '${cmd}' executable not found in PATH`;
    } else if (spawnFailure === 'EACCES') {
      errorMsg = `${label} failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = formatted.userMessage;
    }

    getLog().error(
      { ...formatted.logFields, nodeId: node.id, nodeType: 'script', isTimeout },
      'dag_node_failed'
    );

    return recordNodeState(
      { store: deps.store, logDir },
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

  const output = certified.output;
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const persistedOutput = formatPersistedNodeOutput(output, artifactsDir, stepName);

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
