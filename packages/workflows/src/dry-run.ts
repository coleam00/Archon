/** Side-effect-free workflow DAG simulation with caller-supplied node outputs. */
import { z } from '@hono/zod-openapi';
import { execFileAsync, resolveBashPath } from '@archon/git';
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

const dryRunTraceBaseSchema = z.object({
  nodeId: z.string(),
  nodeType: dryRunNodeTypeSchema,
  resolvedText: z.string().optional(),
  output: z.string().optional(),
  iteration: z.number().int().positive().optional(),
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
  execCode: boolean;
  pauseAtGates: boolean;
  trace: DryRunTraceEntry[];
  consumedStubs: Set<string>;
  missingStubs: Set<string>;
  halted?: 'paused' | 'cancelled';
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
  const artifactsDir = join(ctx.cwd, '.archon', 'dry-run', 'artifacts');
  const stateDir = join(ctx.cwd, '.archon', 'dry-run', 'state');
  const docsDir = join(ctx.cwd, 'docs');
  const substituted = substituteWorkflowVariables(
    text,
    'dry-run',
    ctx.userMessage,
    artifactsDir,
    'dry-run-base',
    docsDir,
    undefined,
    undefined,
    undefined,
    loopPrevOutput,
    { shellSafe, stateDir }
  ).prompt;
  return substituteNodeOutputRefs(substituted, outputs, escapeNodeOutputs);
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
    const result = await execFileAsync(command, args, {
      cwd: ctx.cwd,
      timeout: node.timeout ?? 300_000,
      env: {
        ...process.env,
        USER_MESSAGE: ctx.userMessage,
        ARGUMENTS: ctx.userMessage,
        ARTIFACTS_DIR: join(ctx.cwd, '.archon', 'dry-run', 'artifacts'),
        STATE_DIR: join(ctx.cwd, '.archon', 'dry-run', 'state'),
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

/**
 * Would this iteration's output end the loop, as far as a dry run can tell?
 *
 * The simulator executes nothing, so `until_bash` is unobservable. A loop that
 * declared only `until_bash` (#2563) is therefore assumed to complete on its first
 * iteration: reporting the max-iterations failure the real run would not produce is
 * a worse lie than assuming the deterministic check passes, and the trace reason
 * names the channel that went unevaluated.
 */
function loopIterationCompletes(
  control: { until?: string; until_bash?: string },
  output: string
): boolean {
  if (control.until === undefined) return true;
  return detectCompletionSignal(output, control.until);
}

/** Trace reason for a simulated loop completion — see {@link loopIterationCompletes}. */
function completionReason(control: { until?: string }, iterations: number): string {
  return control.until === undefined
    ? `assumed complete after ${String(iterations)} iteration(s) — 'until_bash' is not executed in a dry run`
    : `completion signal after ${String(iterations)} iteration(s)`;
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
    if (loopIterationCompletes(node.loop, previous)) {
      outputs.set(node.id, hydrated);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop',
        state: 'stubbed',
        reason: completionReason(node.loop, current),
        resolvedText,
        output: previous,
        ...(iteration ? { iteration } : {}),
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
    if (loopIterationCompletes(node.loop_group, lastOutput)) {
      outputs.set(node.id, { state: 'completed', output: lastOutput });
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop_group',
        state: 'completed',
        reason: completionReason(node.loop_group, current),
        output: lastOutput,
        ...(iteration ? { iteration } : {}),
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
      // No `inputs` argument: a dry run resolves no `$INPUTS.<name>` on ANY surface
      // (prompt substitution below throws for it too), so a `when:` referencing one
      // records a failed node rather than silently branching on a value it never had.
      const condition = evaluateCondition(node.when, outputs);
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
  execCode?: boolean;
  pauseAtGates?: boolean;
}): Promise<DryRunResult> {
  const ctx: DryRunContext = {
    workflow: options.workflow,
    userMessage: options.userMessage,
    cwd: options.cwd,
    stubs: options.stubs ?? {},
    execCode: options.execCode ?? false,
    pauseAtGates: options.pauseAtGates ?? false,
    trace: [],
    consumedStubs: new Set<string>(),
    missingStubs: new Set<string>(),
  };
  const outputs = new Map<string, NodeOutput>();
  await simulateNodes(options.workflow.nodes, outputs, ctx);

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
