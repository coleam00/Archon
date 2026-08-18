/** Side-effect-free workflow DAG simulation with caller-supplied node outputs. */
import { z } from '@hono/zod-openapi';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { createLogger, getArchonTempPath } from '@archon/paths';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTopologicalLayers, checkTriggerRule, substituteNodeOutputRefs } from './dag-executor';
import { evaluateCondition } from './condition-evaluator';
import { declaredFieldsFromSchema } from './output-ref';
import { discoverScriptsForCwd } from './script-discovery';
import {
  describeUnmetCompletion,
  detectCompletionSignal,
  isInlineScript,
  loadCommandPrompt,
  substituteWorkflowVariables,
} from './executor-shared';
import {
  resolveNodeModel,
  resolveWorkflowModelScope,
  assistantModelDefaults,
  type NodeModelResolution,
  type WorkflowModelScope,
} from './node-model-resolution';
import type { ResolvedAiProfile } from './model-validation';
import type { WorkflowConfig } from './deps';
import { defaultRunInputs } from './workflow-inputs';
import {
  inputEnvKey,
  isApprovalNode,
  isBashNode,
  isCancelNode,
  isCommandNode,
  isIncludeNode,
  isLoopGroupNode,
  isLoopNode,
  isScriptNode,
  isWorkflowNode,
  type DagNode,
  type NodeOutput,
  type WorkflowDefinition,
} from './schemas';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('workflow.dry-run');
  return cachedLog;
}

export const dryRunStubValueSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
export const dryRunStubsSchema = z.record(z.string(), dryRunStubValueSchema);
export type DryRunStubValue = z.infer<typeof dryRunStubValueSchema>;
export type DryRunStubs = z.infer<typeof dryRunStubsSchema>;

const dryRunNodeTypeSchema = z.enum([
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'loop_group',
  'approval',
  'cancel',
  'include',
  'workflow',
]);

/**
 * Where a node's provider/model will come from at run time.
 *
 * The reason this is reported rather than required per node: after composition collapses a
 * workflow's config onto its own nodes (#1764), the honest answer to "what will this node
 * run on" is a chain, and making every node restate provider+model to make it visible
 * would be ~54 redundant lines in a 27-node workflow. Legibility instead of redundancy.
 */
const dryRunResolutionSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Where each value came from — 'node', 'model ref', 'workflow', 'assistant config', … */
  providerFrom: z.string(),
  modelFrom: z.string(),
  effortFrom: z.string(),
  /** The workflow file this node was authored in, when it arrived through `include:`. */
  authoredIn: z.string().optional(),
  /**
   * Set when the node names one provider while its `model:` ref resolves to another. A
   * real run warns the user about this and uses the resolved provider; a dry run that
   * silently omitted it would report the outcome without the reason for it.
   */
  providerConflict: z
    .object({ declared: z.string(), resolved: z.string(), modelRef: z.string() })
    .optional(),
});
export type DryRunResolution = z.infer<typeof dryRunResolutionSchema>;

const dryRunTraceBaseSchema = z.object({
  nodeId: z.string(),
  nodeType: dryRunNodeTypeSchema,
  resolvedText: z.string().optional(),
  output: z.string().optional(),
  iteration: z.number().int().positive().optional(),
  /** Present for nodes that take an AI turn; absent for bash/script/approval/cancel. */
  resolution: dryRunResolutionSchema.optional(),
});

export const dryRunTraceEntrySchema = z.discriminatedUnion('state', [
  dryRunTraceBaseSchema.extend({
    state: z.literal('completed'),
    reason: z.string().optional(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('stubbed'),
    reason: z.string().optional(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('skipped'),
    reason: z.string(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('failed'),
    reason: z.string(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('paused'),
    reason: z.string(),
  }),
]);
export type DryRunTraceEntry = z.infer<typeof dryRunTraceEntrySchema>;

export const dryRunResultSchema = z.object({
  workflow: z.string(),
  outcome: z.enum(['completed', 'failed', 'paused', 'cancelled']),
  trace: z.array(dryRunTraceEntrySchema),
  missingStubs: z.array(z.string()),
  unusedStubs: z.array(z.string()),
  summary: z.string().optional(),
});
export type DryRunResult = z.infer<typeof dryRunResultSchema>;

export async function loadDryRunStubs(path?: string): Promise<DryRunStubs> {
  if (!path) return {};
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Dry-run stub file not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(await file.text());
  } catch (error) {
    throw new Error(`Failed to parse dry-run stub file '${path}': ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid dry-run stub file '${path}': expected one YAML mapping of node ids to outputs`
    );
  }
  const result = dryRunStubsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid dry-run stub file '${path}': ${issues}`);
  }
  return result.data;
}

function nodeType(node: DagNode): z.infer<typeof dryRunNodeTypeSchema> {
  if (isCommandNode(node)) return 'command';
  if (isBashNode(node)) return 'bash';
  if (isScriptNode(node)) return 'script';
  if (isLoopNode(node)) return 'loop';
  if (isLoopGroupNode(node)) return 'loop_group';
  if (isApprovalNode(node)) return 'approval';
  if (isCancelNode(node)) return 'cancel';
  if (isIncludeNode(node)) return 'include';
  if (isWorkflowNode(node)) return 'workflow';
  return 'prompt';
}

function completedOutput(node: DagNode, stub: DryRunStubValue): NodeOutput {
  const declaredFields = declaredFieldsFromSchema(node.output_format);
  if (typeof stub === 'string') {
    return {
      state: 'completed',
      output: stub,
      ...(declaredFields !== undefined ? { declaredFields } : {}),
    };
  }
  return {
    state: 'completed',
    output: JSON.stringify(stub),
    structuredOutput: stub,
    ...(declaredFields !== undefined ? { declaredFields } : {}),
  };
}

interface DryRunContext {
  workflow: WorkflowDefinition;
  userMessage: string;
  cwd: string;
  stubs: DryRunStubs;
  /**
   * The run's EFFECTIVE `$INPUTS` map — declared defaults layered under caller-supplied
   * values, the same merge a real run performs at executor.ts (`defaultRunInputs`).
   * Undefined when the workflow declares no inputs and the caller supplied none.
   */
  inputs?: Record<string, string>;
  /**
   * Per-simulation `$ARTIFACTS_DIR` / `$STATE_DIR`, under a uniquely named root in
   * `<archonHome>/temp/` — NEVER inside the simulated repository, which holds source
   * only (#2619). Created lazily before the first `--exec-code` execution (#2617) and
   * removed when the simulation ends; a pure-stub dry run creates nothing.
   */
  artifactsDir: string;
  stateDir: string;
  execCode: boolean;
  pauseAtGates: boolean;
  trace: DryRunTraceEntry[];
  consumedStubs: Set<string>;
  missingStubs: Set<string>;
  halted?: 'paused' | 'cancelled';
  /** Workflow-level provider/model fallbacks, for the per-node resolution report. */
  scope: WorkflowModelScope;
  assistantModels: Readonly<Record<string, string | undefined>>;
  aiProfile?: ResolvedAiProfile;
}

async function loadDryRunCommand(cwd: string, command: string): Promise<string> {
  const result = await loadCommandPrompt(
    {
      loadConfig: async () => ({
        assistant: 'claude',
        commands: {},
        assistants: { claude: {}, codex: {} },
        defaults: { loadDefaultCommands: true },
      }),
    },
    cwd,
    command
  );
  if (!result.success) throw new Error(result.message);
  return result.content;
}

function resolveText(
  text: string,
  ctx: DryRunContext,
  outputs: Map<string, NodeOutput>,
  shellSafe = false,
  loopPrevOutput = '',
  escapeNodeOutputs = shellSafe
): string {
  const docsDir = join(ctx.cwd, 'docs');
  const substituted = substituteWorkflowVariables(
    text,
    'dry-run',
    ctx.userMessage,
    ctx.artifactsDir,
    'dry-run-base',
    docsDir,
    undefined,
    undefined,
    undefined,
    loopPrevOutput,
    { shellSafe, stateDir: ctx.stateDir, ...(ctx.inputs ? { inputs: ctx.inputs } : {}) }
  ).prompt;
  return substituteNodeOutputRefs(substituted, outputs, escapeNodeOutputs);
}

/**
 * Report which provider and model an AI-turn node will run on, and where each value came
 * from. Non-AI nodes (bash / script / approval / cancel / include / workflow) make no
 * provider call, so they carry no resolution.
 *
 * Uses the executor's own resolver, never a copy of the chain: a second implementation
 * would drift, and a drifted report is worse than no report.
 */
function resolutionFor(node: DagNode, ctx: DryRunContext): DryRunResolution | undefined {
  const type = nodeType(node);
  if (type !== 'command' && type !== 'prompt' && type !== 'loop' && type !== 'loop_group') {
    return undefined;
  }
  const resolved: NodeModelResolution = resolveNodeModel(
    node,
    ctx.scope,
    ctx.assistantModels,
    ctx.aiProfile
  );
  return {
    provider: resolved.provider,
    ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
    providerFrom: resolved.providerOrigin,
    modelFrom: resolved.modelOrigin,
    effortFrom: resolved.effortOrigin,
    ...(resolved.authoredIn !== undefined ? { authoredIn: resolved.authoredIn } : {}),
    ...(resolved.providerConflict ? { providerConflict: resolved.providerConflict } : {}),
  };
}

/** Spread helper: `{ resolution }` for an AI-turn node, `{}` otherwise. */
function withResolution(node: DagNode, ctx: DryRunContext): { resolution?: DryRunResolution } {
  const resolution = resolutionFor(node, ctx);
  return resolution ? { resolution } : {};
}

function recordSkipped(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  reason: string,
  iteration?: number
): void {
  outputs.set(node.id, { state: 'skipped', output: '' });
  ctx.trace.push({
    nodeId: node.id,
    nodeType: nodeType(node),
    state: 'skipped',
    reason,
    ...(iteration ? { iteration } : {}),
  });
}

function recordFailed(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  reason: string,
  resolvedText?: string,
  iteration?: number
): void {
  outputs.set(node.id, { state: 'failed', output: '', error: reason });
  ctx.trace.push({
    nodeId: node.id,
    nodeType: nodeType(node),
    state: 'failed',
    reason,
    ...(resolvedText !== undefined ? { resolvedText } : {}),
    ...(iteration ? { iteration } : {}),
    // A node that failed for want of a stub is exactly the one an author is inspecting,
    // so it keeps its resolution report.
    ...withResolution(node, ctx),
  });
}

async function executeCodeNode(
  node: DagNode,
  code: string,
  ctx: DryRunContext
): Promise<{ output: string } | { error: string }> {
  try {
    let command: string;
    let args: string[];
    if (isBashNode(node)) {
      command = resolveBashPath();
      args = ['-c', code];
    } else if (isScriptNode(node)) {
      if (isInlineScript(code)) {
        if (node.runtime === 'bun') {
          command = 'bun';
          args = ['--no-env-file', '-e', code];
        } else {
          command = 'uv';
          args = [
            'run',
            ...(node.deps ?? []).flatMap(dep => ['--with', dep]),
            'python',
            '-c',
            code,
          ];
        }
      } else {
        const script = (await discoverScriptsForCwd(ctx.cwd)).get(code);
        if (!script) return { error: `Named script '${code}' was not found` };
        command = script.runtime === 'bun' ? 'bun' : 'uv';
        args =
          script.runtime === 'bun'
            ? ['--no-env-file', 'run', script.path]
            : ['run', ...(node.deps ?? []).flatMap(dep => ['--with', dep]), script.path];
      }
    } else {
      return { error: `Node '${node.id}' is not executable code` };
    }
    // Run-level inputs ride the env bag as `INPUTS_<UPPER_SNAKE>`, never text
    // substitution — the run-inputs half of a real run's `inputEnvVars`
    // (dag-executor.ts). Composed include-block inputs for named scripts are a
    // real-run-only channel the dry run does not deliver.
    const inputEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(ctx.inputs ?? {})) {
      inputEnv[inputEnvKey(name)] = value;
    }
    // The executor pre-creates the artifacts dir it advertises; the simulator honors
    // the same contract (#2617). Idempotent, and only reached when code executes, so
    // a pure-stub dry run creates no directory.
    await mkdir(ctx.artifactsDir, { recursive: true });
    await mkdir(ctx.stateDir, { recursive: true });
    const result = await execFileAsync(command, args, {
      cwd: ctx.cwd,
      timeout: node.timeout ?? 300_000,
      env: {
        ...process.env,
        ...inputEnv,
        USER_MESSAGE: ctx.userMessage,
        ARGUMENTS: ctx.userMessage,
        ARTIFACTS_DIR: ctx.artifactsDir,
        STATE_DIR: ctx.stateDir,
      },
    });
    return { output: result.stdout.replace(/\n$/, '') };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return { error: err.stderr?.trim() || err.message };
  }
}

function stubFor(node: DagNode, ctx: DryRunContext): DryRunStubValue | undefined {
  const stub = ctx.stubs[node.id];
  if (stub !== undefined) ctx.consumedStubs.add(node.id);
  return stub;
}

/** The completion channels a simulated loop may declare. */
interface LoopChannels {
  until?: string;
  until_bash?: string;
  until_field?: string;
}

/** What the dry run can conclude about one simulated iteration. */
type SimulatedCompletion =
  | { kind: 'field' }
  | { kind: 'signal' }
  | { kind: 'assumed' }
  | { kind: 'incomplete' };

/**
 * Would this iteration's output end the loop, as far as a dry run can tell?
 *
 * Two of the three channels are decidable from a stub and one is not:
 *  - `until_field` IS evaluable — a stub object is hydrated onto
 *    `NodeOutput.structuredOutput`, so the engine's own `=== true` rule can be
 *    applied exactly. Guessing here would be strictly worse than deciding.
 *  - `until` IS evaluable — run the same detector the executor runs.
 *  - `until_bash` is NOT: the simulator executes nothing.
 *
 * So: an evaluable channel that fires wins. If none fires but an unevaluable one is
 * declared, assume completion — reporting a max-iterations failure the real run
 * would not produce is the worse lie, and the trace reason names the channel that
 * went unevaluated. If none fires and there is nothing unevaluable to hide behind,
 * the iteration genuinely did not complete.
 *
 * Note the reach of that middle rule (#2563): it fires whenever `until_bash` is
 * declared, INCLUDING alongside an `until:` whose sentinel the stub did not carry.
 * That combination previously simulated as a max-iterations failure, and a shipped
 * default uses it (`archon-adversarial-dev.yaml` declares both). Assuming completion
 * is the honest answer — the real run's `until_bash` may well have fired — but it
 * does mean a dry run cannot prove a prose stub trips `until:` on a loop that also
 * declares `until_bash`. Drop `until_bash` from the workflow, or stub the sentinel,
 * if that is what you are trying to check.
 */
function loopIterationCompletes(
  control: LoopChannels,
  hydrated: { output: string; structuredOutput?: unknown }
): SimulatedCompletion {
  if (control.until_field !== undefined) {
    const payload = hydrated.structuredOutput;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)[control.until_field] === true
    ) {
      return { kind: 'field' };
    }
  }
  if (control.until !== undefined && detectCompletionSignal(hydrated.output, control.until)) {
    return { kind: 'signal' };
  }
  if (control.until_bash !== undefined) return { kind: 'assumed' };
  return { kind: 'incomplete' };
}

/** Trace reason for a simulated loop completion — see {@link loopIterationCompletes}. */
function completionReason(
  completion: SimulatedCompletion,
  control: LoopChannels,
  iterations: number
): string {
  const n = String(iterations);
  switch (completion.kind) {
    case 'field':
      return `'${control.until_field ?? ''}' is true after ${n} iteration(s)`;
    case 'signal':
      return `completion signal after ${n} iteration(s)`;
    default:
      return `assumed complete after ${n} iteration(s) — 'until_bash' is not executed in a dry run`;
  }
}

async function simulateLoop(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  if (!isLoopNode(node)) return;
  let previous = '';
  const template = node.loop.prompt ?? (await loadDryRunCommand(ctx.cwd, node.loop.command ?? ''));
  let resolvedText = template;
  for (let current = 1; current <= node.loop.max_iterations; current++) {
    resolvedText = resolveText(template, ctx, outputs, false, previous);
    const stub = stubFor(node, ctx);
    if (stub === undefined) {
      ctx.missingStubs.add(node.id);
      recordFailed(
        node,
        outputs,
        ctx,
        `Missing reachable stub for node '${node.id}'`,
        resolvedText,
        iteration
      );
      return;
    }
    const hydrated = completedOutput(node, stub);
    previous = hydrated.output;
    const completion = loopIterationCompletes(node.loop, hydrated);
    if (completion.kind !== 'incomplete') {
      outputs.set(node.id, hydrated);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop',
        state: 'stubbed',
        reason: completionReason(completion, node.loop, current),
        resolvedText,
        output: previous,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
      return;
    }
  }
  recordFailed(
    node,
    outputs,
    ctx,
    `Loop exceeded max iterations (${String(node.loop.max_iterations)}) ${describeUnmetCompletion(node.loop)}`,
    resolvedText,
    iteration
  );
}

async function simulateLoopGroup(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  if (!isLoopGroupNode(node)) return;
  let lastOutput = '';
  for (let current = 1; current <= node.loop_group.max_iterations; current++) {
    const bodyOutputs = new Map(outputs);
    await simulateNodes(node.loop_group.nodes, bodyOutputs, ctx, current);
    const bodyDependencies = new Set(node.loop_group.nodes.flatMap(body => body.depends_on ?? []));
    lastOutput =
      node.loop_group.nodes
        .filter(body => !bodyDependencies.has(body.id))
        .map(body => bodyOutputs.get(body.id))
        .find(output => output?.state === 'completed' && output.output.trim())?.output ?? '';
    const failed = node.loop_group.nodes.some(body => bodyOutputs.get(body.id)?.state === 'failed');
    if (failed) {
      recordFailed(
        node,
        outputs,
        ctx,
        `Loop group body failed at iteration ${String(current)}`,
        undefined,
        iteration
      );
      return;
    }
    if (ctx.halted) return;
    const groupCompletion = loopIterationCompletes(node.loop_group, { output: lastOutput });
    if (groupCompletion.kind !== 'incomplete') {
      outputs.set(node.id, { state: 'completed', output: lastOutput });
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop_group',
        state: 'completed',
        reason: completionReason(groupCompletion, node.loop_group, current),
        output: lastOutput,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
      return;
    }
  }
  recordFailed(
    node,
    outputs,
    ctx,
    `Loop group exceeded max iterations (${String(node.loop_group.max_iterations)}) ${describeUnmetCompletion(node.loop_group)}`,
    undefined,
    iteration
  );
}

async function simulateNode(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  if (checkTriggerRule(node, outputs) === 'skip') {
    recordSkipped(node, outputs, ctx, 'trigger_rule', iteration);
    return;
  }
  if (node.when) {
    try {
      // `ctx.inputs` mirrors the executor's `resolveRunInputs` (#2610): a `when:`
      // referencing `$INPUTS.<name>` branches on the same effective map a real run reads.
      const condition = evaluateCondition(node.when, outputs, ctx.inputs);
      if (!condition.parsed) {
        recordSkipped(node, outputs, ctx, 'when_condition_parse_error', iteration);
        return;
      }
      if (!condition.result) {
        recordSkipped(node, outputs, ctx, 'when_condition_false', iteration);
        return;
      }
    } catch (error) {
      recordFailed(node, outputs, ctx, (error as Error).message, undefined, iteration);
      return;
    }
  }

  try {
    if (isLoopNode(node)) {
      await simulateLoop(node, outputs, ctx, iteration);
      return;
    }
    if (isLoopGroupNode(node)) {
      await simulateLoopGroup(node, outputs, ctx, iteration);
      return;
    }
    if (isApprovalNode(node)) {
      const resolvedText = resolveText(node.approval.message, ctx, outputs);
      if (ctx.pauseAtGates) {
        outputs.set(node.id, { state: 'pending', output: '' });
        ctx.trace.push({
          nodeId: node.id,
          nodeType: 'approval',
          state: 'paused',
          reason: 'approval gate',
          resolvedText,
          ...(iteration ? { iteration } : {}),
        });
        ctx.halted = 'paused';
      } else {
        outputs.set(node.id, { state: 'completed', output: 'approved' });
        ctx.trace.push({
          nodeId: node.id,
          nodeType: 'approval',
          state: 'completed',
          reason: 'auto-approved',
          resolvedText,
          output: 'approved',
          ...(iteration ? { iteration } : {}),
        });
      }
      return;
    }
    if (isCancelNode(node)) {
      const resolvedText = resolveText(node.cancel, ctx, outputs);
      outputs.set(node.id, { state: 'completed', output: resolvedText });
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'cancel',
        state: 'completed',
        reason: 'workflow cancelled',
        resolvedText,
        output: resolvedText,
        ...(iteration ? { iteration } : {}),
      });
      ctx.halted = 'cancelled';
      return;
    }
    if (isIncludeNode(node) || isWorkflowNode(node)) {
      recordFailed(
        node,
        outputs,
        ctx,
        `Dry-run does not execute reachable ${nodeType(node)} nodes`,
        undefined,
        iteration
      );
      return;
    }

    const sourceText = isCommandNode(node)
      ? await loadDryRunCommand(ctx.cwd, node.command)
      : isBashNode(node)
        ? node.bash
        : isScriptNode(node)
          ? node.script
          : node.prompt;
    const resolvedText = isScriptNode(node)
      ? resolveText(sourceText, ctx, outputs, true, '', false)
      : resolveText(sourceText, ctx, outputs, isBashNode(node));
    const stub = stubFor(node, ctx);
    if (stub !== undefined) {
      const hydrated = completedOutput(node, stub);
      outputs.set(node.id, hydrated);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: nodeType(node),
        state: 'stubbed',
        resolvedText,
        output: hydrated.output,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
      return;
    }
    if ((isBashNode(node) || isScriptNode(node)) && ctx.execCode) {
      const executed = await executeCodeNode(node, resolvedText, ctx);
      if ('error' in executed) {
        recordFailed(node, outputs, ctx, executed.error, resolvedText, iteration);
      } else {
        outputs.set(node.id, { state: 'completed', output: executed.output });
        ctx.trace.push({
          nodeId: node.id,
          nodeType: nodeType(node),
          state: 'completed',
          reason: 'executed locally',
          resolvedText,
          output: executed.output,
          ...(iteration ? { iteration } : {}),
        });
      }
      return;
    }
    ctx.missingStubs.add(node.id);
    recordFailed(
      node,
      outputs,
      ctx,
      `Missing reachable stub for node '${node.id}'`,
      resolvedText,
      iteration
    );
  } catch (error) {
    recordFailed(node, outputs, ctx, (error as Error).message, undefined, iteration);
  }
}

async function simulateNodes(
  nodes: readonly DagNode[],
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  for (const layer of buildTopologicalLayers(nodes)) {
    for (const node of layer) {
      if (ctx.halted) return;
      await simulateNode(node, outputs, ctx, iteration);
    }
  }
}

export async function dryRunWorkflow(options: {
  workflow: WorkflowDefinition;
  userMessage: string;
  cwd: string;
  stubs?: DryRunStubs;
  /**
   * Caller-SUPPLIED input values, already validated against the workflow's declared
   * `inputs:` at the invocation gate (`resolveTopLevelInputs`) — the same contract a
   * real run enforces before any cost. Declared defaults are derived here, not by the
   * caller, mirroring the executor's split (`defaultRunInputs` at run start), so the
   * effective `$INPUTS` map cannot diverge between simulation and execution (#2610).
   */
  inputs?: Record<string, string>;
  execCode?: boolean;
  pauseAtGates?: boolean;
  /**
   * The install's resolved config and AI profile. Supplying them is what makes the
   * per-node provider/model report match what a real run would do; without them the
   * report falls back to the bare default assistant with no tier or alias resolution.
   */
  config?: WorkflowConfig;
  aiProfile?: ResolvedAiProfile;
}): Promise<DryRunResult> {
  const assistantModels = options.config ? assistantModelDefaults(options.config) : {};
  // Same layering as the executor: declared defaults under caller-supplied values
  // (supplied wins). A workflow with no `inputs:` block keeps passthrough semantics.
  const declaredDefaults = defaultRunInputs(options.workflow.inputs);
  const inputs =
    declaredDefaults || options.inputs ? { ...declaredDefaults, ...options.inputs } : undefined;
  const tempRoot = join(getArchonTempPath(), `dry-run-${randomUUID()}`);
  const ctx: DryRunContext = {
    workflow: options.workflow,
    userMessage: options.userMessage,
    cwd: options.cwd,
    stubs: options.stubs ?? {},
    ...(inputs ? { inputs } : {}),
    artifactsDir: join(tempRoot, 'artifacts'),
    stateDir: join(tempRoot, 'state'),
    execCode: options.execCode ?? false,
    pauseAtGates: options.pauseAtGates ?? false,
    trace: [],
    consumedStubs: new Set<string>(),
    missingStubs: new Set<string>(),
    scope: resolveWorkflowModelScope(
      options.workflow,
      options.config?.assistant ?? 'claude',
      assistantModels,
      options.aiProfile
    ),
    assistantModels,
    ...(options.aiProfile ? { aiProfile: options.aiProfile } : {}),
  };
  const outputs = new Map<string, NodeOutput>();
  try {
    await simulateNodes(options.workflow.nodes, outputs, ctx);
  } finally {
    // Simulations are throwaway: whatever exec'd nodes wrote is discarded with the
    // per-run root (`force: true` makes the nothing-executed case a no-op). A cleanup
    // failure must not fail a finished simulation, so it is logged, not thrown.
    await rm(tempRoot, { recursive: true, force: true }).catch((error: unknown) => {
      getLog().warn(
        { tempRoot, error: error instanceof Error ? error.message : String(error) },
        'dry_run.temp_cleanup_failed'
      );
    });
  }

  const dependencies = new Set(options.workflow.nodes.flatMap(node => node.depends_on ?? []));
  const summary = options.workflow.nodes
    .filter(node => !dependencies.has(node.id))
    .map(node => outputs.get(node.id))
    .find(output => output?.state === 'completed' && output.output.trim())?.output;
  const anyFailed = [...outputs.values()].some(output => output.state === 'failed');
  const outcome =
    ctx.halted === 'paused'
      ? 'paused'
      : ctx.halted === 'cancelled'
        ? 'cancelled'
        : anyFailed
          ? 'failed'
          : 'completed';
  return dryRunResultSchema.parse({
    workflow: options.workflow.name,
    outcome,
    trace: ctx.trace,
    missingStubs: [...ctx.missingStubs].sort(),
    unusedStubs: Object.keys(ctx.stubs)
      .filter(id => !ctx.consumedStubs.has(id))
      .sort(),
    ...(summary ? { summary } : {}),
  });
}

export function formatDryRunTrace(result: DryRunResult): string {
  const lines = [`Dry-run: ${result.workflow}`, ''];
  for (const entry of result.trace) {
    const suffix = entry.reason ? ` — ${entry.reason}` : '';
    const iteration = entry.iteration ? ` [iteration ${String(entry.iteration)}]` : '';
    lines.push(
      `${entry.state.toUpperCase().padEnd(9)} ${entry.nodeId} (${entry.nodeType})${iteration}${suffix}`
    );
    if (entry.resolution) {
      const r = entry.resolution;
      const authored = r.authoredIn ? ` [from ${r.authoredIn}]` : '';
      const model = r.model ?? '(provider default)';
      lines.push(
        `  runs on: ${r.provider} (${r.providerFrom}) / ${model} (${r.modelFrom})${authored}`
      );
      if (r.effort) lines.push(`  effort: ${r.effort} (${r.effortFrom})`);
      if (r.providerConflict) {
        const c = r.providerConflict;
        lines.push(
          `  warning: declares provider '${c.declared}' but model '${c.modelRef}' resolves to '${c.resolved}' — using '${c.resolved}'`
        );
      }
    }
    if (entry.resolvedText) lines.push(`  resolved: ${entry.resolvedText}`);
    if (entry.output !== undefined) lines.push(`  output: ${entry.output}`);
  }
  lines.push('', `Outcome: ${result.outcome}`);
  if (result.missingStubs.length > 0)
    lines.push(`Missing stubs: ${result.missingStubs.join(', ')}`);
  if (result.unusedStubs.length > 0) lines.push(`Unused stubs: ${result.unusedStubs.join(', ')}`);
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  return lines.join('\n');
}
