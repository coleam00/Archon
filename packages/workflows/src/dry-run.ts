/** Side-effect-free workflow DAG simulation with caller-supplied node outputs. */
import { createLogger, getArchonTempPath } from '@archon/paths';
import { validateStructuredOutput } from './structured-output';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readComposedBindings } from './compiled-command';
import { parseWholeExecutionCheckoutRef } from './output-ref';
import { resolveWorkflowModelScope, assistantModelDefaults } from './node-model-resolution';
import type { ResolvedAiProfile } from './model-validation';
import type { WorkflowConfig } from './deps';
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import { defaultRunInputs } from './workflow-inputs';
import {
  isExecNode,
  isAgentNode,
  isLoopGroupNode,
  type DagNode,
  type NodeOutput,
  type ResolvedWorkflow,
  type WorkflowRunOutcome,
} from './schemas';
import type { DryRunContext } from './dry-run/context';
import { dryRunResultSchema, type DryRunResult } from './dry-run/schemas';
import { isRecord, type DryRunStubs } from './dry-run/stubs';
import { simulateNodes } from './dry-run/simulate';

export {
  dryRunResultSchema,
  dryRunTraceEntrySchema,
  type DryRunResolution,
  type DryRunResult,
  type DryRunTraceEntry,
} from './dry-run/schemas';
export {
  RESERVED_FIXTURE_KEYS,
  createDryRunStubScaffold,
  dryRunStubValueSchema,
  dryRunStubsSchema,
  loadDryRunStubs,
  writeDryRunStubScaffold,
  type DryRunStubValue,
  type DryRunStubs,
} from './dry-run/stubs';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('workflow.dry-run');
  return cachedLog;
}

/** Producers some node binds with `$<node>.execution.checkoutStart`, at any depth. */
function collectCheckoutProducers(
  nodes: readonly DagNode[],
  into = new Set<string>()
): Set<string> {
  for (const node of nodes) {
    if (isLoopGroupNode(node)) collectCheckoutProducers(node.loop_group.nodes as DagNode[], into);
    const nodeWith = isExecNode(node)
      ? node.with
      : isAgentNode(node)
        ? node.source.kind === 'command'
          ? node.source.with
          : readComposedBindings(node)
        : undefined;
    for (const value of Object.values(nodeWith ?? {})) {
      const producer =
        typeof value === 'string' ? parseWholeExecutionCheckoutRef(value) : undefined;
      if (producer !== undefined) into.add(producer);
    }
  }
  return into;
}

function resolveDryRunAuthoredOutcome(
  workflow: ResolvedWorkflow,
  outputs: ReadonlyMap<string, NodeOutput>,
  consumedStubs: ReadonlySet<string>
): WorkflowRunOutcome | null {
  const field = workflow.outcome_field;
  const returns = workflow.returns;
  if (field === undefined || returns === undefined || !consumedStubs.has(returns)) return null;

  const selectedOutput = outputs.get(returns);
  if (selectedOutput?.state !== 'completed' || !('structuredOutput' in selectedOutput)) return null;

  const structured = selectedOutput.structuredOutput;
  const selectedNode = workflow.nodes.find(node => node.id === returns);
  if (
    selectedNode?.output_format === undefined ||
    !validateStructuredOutput(structured, selectedNode.output_format).valid
  ) {
    return null;
  }
  if (!isRecord(structured) || !Object.hasOwn(structured, field)) return null;

  const verdict = structured[field];
  return typeof verdict === 'boolean' ? (verdict ? 'succeeded' : 'failed') : null;
}

export async function dryRunWorkflow(options: {
  workflow: ResolvedWorkflow;
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
  /**
   * Where exec-code nodes execute. Undefined means `cwd` — the direct
   * `--dry-run --exec-code` path. `workflow test` supplies an isolated scratch
   * worktree so a fixture verdict cannot depend on the caller's tree state (#2851).
   */
  execWorkspace?: string;
  /**
   * Where named scripts and command files are READ from. Undefined means live off
   * `cwd`, which is the direct `--dry-run` path; `workflow test` passes the roots of
   * the source capture it froze for the invocation (#2851).
   */
  sourceRoots?: WorkflowSourceRoots;
  execCode?: boolean;
  /** Fill reached nodes without explicit stubs using schema-valid deterministic placeholders. */
  defaultStubs?: boolean;
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
    execWorkspace: options.execWorkspace ?? options.cwd,
    sourceRoots: options.sourceRoots ?? liveSourceRoots(options.cwd),
    stubs: options.stubs ?? {},
    checkoutProducers: collectCheckoutProducers(options.workflow.nodes),
    ...(inputs ? { inputs } : {}),
    loopBodyScopes: [],
    artifactsDir: join(tempRoot, 'artifacts'),
    stateDir: join(tempRoot, 'state'),
    logDir: join(tempRoot, 'logs'),
    execCode: options.execCode ?? false,
    defaultStubs: options.defaultStubs ?? false,
    pauseAtGates: options.pauseAtGates ?? false,
    trace: [],
    consumedStubs: new Set<string>(),
    missingStubs: new Set<string>(),
    toleratedMissingStubs: new Set<string>(),
    scope: resolveWorkflowModelScope(
      options.workflow,
      options.config?.assistant,
      assistantModels,
      options.aiProfile
    ),
    assistantModels,
    ...(options.aiProfile ? { aiProfile: options.aiProfile } : {}),
  };
  const outputs = new Map<string, NodeOutput>();
  try {
    await simulateNodes(options.workflow.plan, outputs, ctx);
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

  const summary = options.workflow.plan.sinks
    .map(nodeId => outputs.get(nodeId))
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
    authoredOutcome: resolveDryRunAuthoredOutcome(options.workflow, outputs, ctx.consumedStubs),
    trace: ctx.trace,
    missingStubs: [...ctx.missingStubs].sort(),
    toleratedMissingStubs: [...ctx.toleratedMissingStubs].sort(),
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
  lines.push(
    '',
    `Simulation outcome: ${result.outcome}`,
    `Authored outcome: ${result.authoredOutcome ?? 'undeclared'}`
  );
  if (result.missingStubs.length > 0)
    lines.push(`Missing stubs: ${result.missingStubs.join(', ')}`);
  if (result.unusedStubs.length > 0) lines.push(`Unused stubs: ${result.unusedStubs.join(', ')}`);
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  return lines.join('\n');
}
