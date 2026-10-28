import { scriptInvocation } from '../../../script-invocation';
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
import { discoverScriptsForCwd, type ScriptDefinition } from '../../../script-discovery';
import {
  capturedSourceReadGuard,
  assertCapturedFilesPresent,
  isSourceReadFailure,
} from '../../../workflow-source';
import type { ExecNode } from '../../../schemas';
import { writeNodeArtifactsListing } from '../../../artifacts-index';
import { currentAdoptedRunDir, substituteWorkflowVariables } from '../../../workflow-variables';
import {
  isInlineScript,
  formatHostSpawnFailure,
  formatSubprocessFailure,
} from '../../../executor-shared';
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
  const nodeStartTime = Date.now();
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = ctx.stepNamePrefix + node.id;
  // Fresh per call, same as executeBashNode: one attempt, one observation.
  const typedArtifactsFile = await writeNodeArtifactsListing(ctx.artifactsDir, ctx.workflowRun.id);
  const finalScript = substituteScript(ctx, node, typedArtifactsFile);
  const source = await captureScriptSource(ctx, finalScript, stepName);
  await reserveBudget();
  const execution = await startScriptExecution(ctx, node);
  const subprocessEnv = scriptEnvironment(ctx, node, typedArtifactsFile, execution);

  const lookup = resolveScriptInvocation(ctx, node, finalScript, source.namedScripts);
  if ('errorMsg' in lookup) return recordScriptConfigFailure(ctx, node, execution, lookup.errorMsg);
  await recheckNamedScriptSource(source, finalScript, stepName);

  let certified: ReturnType<typeof certifyExecOutput>;
  try {
    certified = await runScript(ctx, node, lookup, subprocessEnv);
  } catch (error) {
    return recordScriptFailure(ctx, node, execution, lookup.command, error);
  }
  return recordScriptSuccess(ctx, node, execution, certified, nodeStartTime);
}

type ScriptInvocation = ReturnType<typeof scriptInvocation>;

/** Discovered named scripts, the discovery error, or undefined for an inline script. */
interface ScriptSource {
  verifiedScriptFiles: ReadonlySet<string> | undefined;
  namedScripts: Map<string, ScriptDefinition> | Error | undefined;
}

/**
 * Resolve before deciding whether this is inline or filesystem-backed: substitutions
 * can turn the authored field into either form. User-controlled variables stay in
 * subprocess env instead of being spliced into TS/Python source; strict node-output
 * references keep raw substitution (#2115).
 */
function substituteScript(
  ctx: RunLayersContext,
  node: ExecNode,
  typedArtifactsFile: string
): string {
  const { workflowRun } = ctx;
  return substituteWorkflowVariables(
    node.script,
    workflowRun.id,
    workflowRun.user_message,
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext,
    undefined,
    undefined,
    undefined,
    {
      shellSafe: true,
      stateDir: ctx.stateDir,
      typedArtifactsFile,
      references: nodeTemplateReferences(node.script, ctx, 'script'),
    }
  ).prompt;
}

/**
 * A named source is checked outside the deterministic retry classifier, so an integrity
 * failure cannot consume retries. A discovery failure is returned, not thrown, and settles
 * the node as a config failure once its execution has started.
 */
async function captureScriptSource(
  ctx: RunLayersContext,
  finalScript: string,
  stepName: string
): Promise<ScriptSource> {
  if (isInlineScript(finalScript))
    return { verifiedScriptFiles: undefined, namedScripts: undefined };
  const verifiedScriptFiles = await assertNodeSourceReadable(ctx.workflowSourceRoots, stepName);
  const namedScripts = await discoverScriptsForCwd(
    ctx.cwd,
    ctx.workflowSourceRoots,
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
  return { verifiedScriptFiles, namedScripts };
}

async function startScriptExecution(
  ctx: RunLayersContext,
  node: ExecNode
): Promise<NodeExecutionRecord> {
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, { checkoutStart: await observeNodeCheckout(ctx) }),
    diagnostics: { ...(iteration !== undefined ? { iteration } : {}) },
  };
  getLog().info({ nodeId: node.id, type: 'script', runtime: node.runtime }, 'dag_node_started');
  await recordNodeState({ store: ctx.deps.store, logDir: ctx.logDir }, execution);
  return execution;
}

/**
 * Archon-managed env only — runSubprocess adds the host env for host runs and
 * delivers ONLY this bag into the container (host process.env never crosses).
 * User-controlled values ride env vars (never spliced into source) — the
 * sanctioned injection-safe channel, matching executeBashNode (#2115).
 */
function scriptEnvironment(
  ctx: RunLayersContext,
  node: ExecNode,
  typedArtifactsFile: string,
  execution: NodeExecutionRecord
): NodeJS.ProcessEnv {
  const { workflowRun } = ctx;
  return {
    ...buildNodeShellEnvironment(node, ctx, ctx.config.envVars, {
      artifactsDir: ctx.artifactsDir,
      stateDir: ctx.stateDir,
      logDir: ctx.logDir,
      workflowId: workflowRun.id,
      baseBranch: ctx.baseBranch,
      userMessage: workflowRun.user_message,
      loopUserInput: ctx.bodyLoopUserInput ?? '',
      loopPrevOutput: '',
      rejectionReason: '',
      issueContext: ctx.issueContext,
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
}

/**
 * Named scripts are looked up across repo and home scopes.
 * Precedence: <cwd>/.archon/scripts/ > ~/.archon/scripts/ (repo wins).
 */
function resolveScriptInvocation(
  ctx: RunLayersContext,
  node: ExecNode,
  finalScript: string,
  namedScripts: ScriptSource['namedScripts']
): ScriptInvocation | { errorMsg: string } {
  if (isInlineScript(finalScript)) {
    return scriptInvocation(
      node.runtime === 'bun' ? 'bun' : 'uv',
      { kind: 'inline', code: finalScript },
      node.deps
    );
  }
  if (namedScripts instanceof Error) {
    const err = namedScripts;
    getLog().error({ err, nodeId: node.id, cwd: ctx.cwd }, 'script_discovery_failed');
    return {
      errorMsg: `Script node '${node.id}': failed to discover scripts — ${err.message}`,
    };
  }
  const scriptDef = namedScripts?.get(finalScript);
  if (!scriptDef) {
    getLog().error({ nodeId: node.id, scriptName: finalScript }, 'script_not_found');
    return {
      errorMsg: `Script node '${node.id}': named script '${finalScript}' not found in .archon/scripts/ or ~/.archon/scripts/`,
    };
  }
  return scriptInvocation(scriptDef.runtime, { kind: 'file', path: scriptDef.path }, node.deps);
}

async function recordScriptConfigFailure(
  ctx: RunLayersContext,
  node: ExecNode,
  execution: NodeExecutionRecord,
  errorMsg: string
): Promise<NodeExecutionResult> {
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    errorMsg,
    scriptMessageContext(ctx, node)
  );
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      execution,
      { status: 'failed', error: errorMsg, failureKind: 'config' },
      { output: { text: '' } }
    )
  );
}

/**
 * After dispatch, a rejection may follow user side effects; source recovery must not
 * replace that outcome. Recheck while execution is still known not to have started.
 */
async function recheckNamedScriptSource(
  { verifiedScriptFiles, namedScripts }: ScriptSource,
  finalScript: string,
  stepName: string
): Promise<void> {
  const selected = namedScripts instanceof Map ? namedScripts.get(finalScript) : undefined;
  if (!selected) return;
  try {
    await Promise.all([...(verifiedScriptFiles ?? [selected.path])].map(path => readFile(path)));
  } catch (error) {
    if (isSourceReadFailure(error, verifiedScriptFiles))
      throw new RunSourceUnreadableError(stepName, error);
    throw error;
  }
}

async function runScript(
  ctx: RunLayersContext,
  node: ExecNode,
  { command, args }: ScriptInvocation,
  env: NodeJS.ProcessEnv
): Promise<ReturnType<typeof certifyExecOutput>> {
  const { workflowRun } = ctx;
  const { stdout, stderr, credentialValues } = await runSubprocessUntilRunStops(
    ctx.deps.store,
    workflowRun.id,
    node.id,
    ctx.execContext,
    command,
    args,
    {
      cwd: ctx.cwd,
      timeout: node.timeout,
      endTreeOnTimeout: true,
      env,
      protectedEnvKeys: ctx.config.protectedEnvKeys,
      protectedCredentialValues: ctx.config.protectedCredentialValues,
      retention: {
        logDir: ctx.logDir,
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
      ctx.platform,
      ctx.conversationId,
      `Script node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
      scriptMessageContext(ctx, node)
    );
  }

  // Identical certification to executeBashNode (#2453): a declared output_format makes
  // this node's stdout a contract, and the canonical document replaces the raw text.
  const certified = certifyExecOutput(node, trimmedStdout, credentialValues);
  await assertExecArtifactPointers(workflowRun, node, certified.structuredOutput);
  return certified;
}

async function recordScriptFailure(
  ctx: RunLayersContext,
  node: ExecNode,
  execution: NodeExecutionRecord,
  command: ScriptInvocation['command'],
  error: unknown
): Promise<NodeExecutionResult> {
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
  const spawnMessage = formatHostSpawnFailure(
    hostSpawnFailure(ctx.execContext, err),
    node.runtime,
    command,
    label
  );
  const errorMsg =
    scriptFailureMessage(node, err, label, { contractFailure, isTimeout, spawnMessage }) ??
    formatted.userMessage;

  getLog().error(
    { ...formatted.logFields, nodeId: node.id, nodeType: 'script', isTimeout },
    'dag_node_failed'
  );

  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      execution,
      {
        status: 'failed',
        error: errorMsg,
        failureKind: scriptFailureKind(err, contractFailure, isTimeout),
        ...(contractFailure ? { retryable: false as const } : {}),
      },
      { output: { text: '' } }
    )
  );
}

/** The user-facing failure message, or undefined to use the formatter's sanitized one. */
function scriptFailureMessage(
  node: ExecNode,
  err: RawSubprocessRejection,
  label: string,
  facts: { contractFailure: boolean; isTimeout: boolean; spawnMessage: string | undefined }
): string | undefined {
  if (facts.contractFailure) return err.message;
  if (facts.isTimeout) return `${label} timed out after ${String(node.timeout)}ms`;
  if (err.treeSurvived) return `${label} failed: ${err.message}`;
  if (err.cancelled) return `${label} cancelled`;
  return facts.spawnMessage;
}

function scriptFailureKind(
  err: RawSubprocessRejection,
  contractFailure: boolean,
  isTimeout: boolean
): 'output_contract' | 'cancelled' | 'timeout' | 'exec_failed' {
  if (contractFailure) return 'output_contract';
  if (err.cancelled) return 'cancelled';
  if (isTimeout) return 'timeout';
  return 'exec_failed';
}

async function recordScriptSuccess(
  ctx: RunLayersContext,
  node: ExecNode,
  execution: NodeExecutionRecord,
  certified: ReturnType<typeof certifyExecOutput>,
  nodeStartTime: number
): Promise<NodeExecutionResult> {
  const output = certified.output;
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const persistedOutput = formatPersistedNodeOutput(output, ctx.artifactsDir);

  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
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

function scriptMessageContext(ctx: RunLayersContext, node: ExecNode): SendMessageContext {
  return { workflowId: ctx.workflowRun.id, nodeName: node.id };
}
