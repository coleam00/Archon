/** The state one dry-run simulation threads through every node, and the helpers each node kind shares. */
import type { WorkflowConfig } from '../deps';
import type { InteractionAdmission } from '../interaction-admission';
import { join } from 'node:path';
import {
  nodeTemplateReferences,
  type ShellInputContext,
  type TextSurface,
} from '../dag/references';
import { type LoopBodyScope } from '../dag/loop-scope';
import { resolveIncludeOutputAliases } from '../compiled-command';
import type { JsonValue } from '../output-ref';
import { loadCommandPrompt } from '../load-command-prompt';
import { substituteWorkflowVariables } from '../workflow-variables';
import { resolveNodeModelScope, type WorkflowModelScope } from '../node-model-resolution';
import type { ResolvedAiProfile } from '../model-validation';
import { assertWorkflowSourceIntegrity, type WorkflowSourceRoots } from '../workflow-source';
import {
  isGateNode,
  isExecNode,
  isHaltNode,
  isAgentNode,
  isComposeFanOutNode,
  isLoopGroupNode,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
  type DagNode,
  type NodeOutput,
  type SkipCause,
  type ResolvedWorkflow,
} from '../schemas';
import type { DryRunNodeType, DryRunResolution, DryRunTraceEntry } from './schemas';
import {
  assertAuthoredStubSatisfiesSchema,
  generatedStubFor,
  type DryRunStubs,
  type DryRunStubValue,
} from './stubs';

export function nodeType(node: DagNode): DryRunNodeType {
  // `include:` is no longer a DagNode member (#2486) — it never reaches this function.
  if (isAgentNode(node) && node.source.kind === 'command') return 'command';
  if (isExecNode(node)) return node.runtime === 'sh' ? 'bash' : 'script';
  if (isLoopNode(node)) return 'loop';
  if (isLoopGroupNode(node)) return 'loop_group';
  if (isGateNode(node)) return 'approval';
  if (isWaitNode(node)) return 'wait';
  if (isHaltNode(node)) return 'cancel';
  if (isWorkflowNode(node)) return 'workflow';
  if (isComposeFanOutNode(node)) return 'compose_fan_out';
  return 'prompt';
}

export interface DryRunContext
  extends Pick<WorkflowConfig, 'envVars' | 'protectedEnvKeys' | 'protectedCredentialValues'> {
  workflow: ResolvedWorkflow;
  userMessage: string;
  cwd: string;
  /**
   * The working directory trusted bash/script code EXECUTES in (exec-code nodes only).
   * Defaults to `cwd`; `workflow test` points it at a scratch worktree of HEAD (#2851)
   * so executed nodes see a clean checkout and cannot write into the caller's tree.
   */
  execWorkspace: string;
  /**
   * Where a named script's file and a `command:` node's text are READ from — the same
   * source/target split a real run makes. Defaults to reading `cwd` live, which is the
   * direct `--dry-run` path; `workflow test` supplies its capture's roots so a fixture
   * executes the bytes a real run would freeze (#2851).
   */
  sourceRoots: WorkflowSourceRoots;
  stubs: DryRunStubs;
  /** Nodes whose execution record some binding reads (`$<node>.execution.checkoutStart`). */
  checkoutProducers: ReadonlySet<string>;
  /**
   * The run's EFFECTIVE `$INPUTS` map — declared defaults layered under caller-supplied
   * values, the same merge a real run performs at executor.ts (`defaultRunInputs`).
   * Undefined when the workflow declares no inputs and the caller supplied none.
   * Values are logical JSON values (#2637 — a typed declared default stays typed).
   */
  inputs?: Record<string, JsonValue>;
  /**
   * The enclosing loop_group's previous-iteration outputs, the snapshot a body `when:`
   * resolves `$LOOP_PREV.*` against. Empty on the first iteration; undefined outside a
   * loop_group body, where the condition parser rejects `$LOOP_PREV`.
   */
  loopPrevOutputs?: ReadonlyMap<string, NodeOutput>;
  /**
   * One scope per enclosing loop_group iteration, outermost first; every body text
   * resolves against them, as in a real run (`RunLayersContext.loopBodyScopes`).
   */
  loopBodyScopes: readonly LoopBodyScope[];
  /**
   * Per-simulation `$ARTIFACTS_DIR` / `$STATE_DIR` / `$LOG_DIR`, under a uniquely named root in
   * `<archonHome>/temp/` — NEVER inside the simulated repository, which holds source
   * only (#2619). Created lazily before the first `--exec-code` execution (#2617) and
   * removed when the simulation ends; a pure-stub dry run creates nothing.
   */
  artifactsDir: string;
  stateDir: string;
  logDir: string;
  execCode: boolean;
  defaultStubs: boolean;
  pauseAtGates: boolean;
  trace: DryRunTraceEntry[];
  consumedStubs: Set<string>;
  missingStubs: Set<string>;
  /** Always a subset of `missingStubs` — see {@link dryRunResultSchema}'s field doc. */
  toleratedMissingStubs: Set<string>;
  halted?: 'paused' | 'cancelled';
  interactionAdmission?: InteractionAdmission;
  /** Workflow-level provider/model fallbacks, for the per-node resolution report. */
  scope: WorkflowModelScope;
  assistantModels: Readonly<Record<string, string | undefined>>;
  aiProfile?: ResolvedAiProfile;
}

export async function loadDryRunCommand(
  ctx: DryRunContext,
  node: DagNode,
  command: string
): Promise<string> {
  await assertWorkflowSourceIntegrity(ctx.sourceRoots);
  const result = await loadCommandPrompt(
    {
      // Unreachable: `loadCommandPrompt` consults `loadConfig` only when its source roots
      // carry no `load_default_commands`, and `ctx.sourceRoots` always does — the field is
      // a required boolean on every roots value. Throwing rather than returning a stub
      // config keeps a future signature change from silently resolving commands against a
      // fabricated policy.
      loadConfig: () => {
        throw new Error('dry-run resolves commands from its source roots, never from config');
      },
    },
    ctx.cwd,
    command,
    undefined,
    ctx.sourceRoots
  );
  if (!result.success) throw new Error(result.message);
  return resolveIncludeOutputAliases(node, result.content);
}

export function resolveText(
  text: string,
  ctx: DryRunContext,
  outputs: Map<string, NodeOutput>,
  surface: TextSurface = 'prompt',
  loopPrevOutput = '',
  // The `$INPUTS` bag for this text — run-level inputs unless the node carries
  // node-local `with:` bindings, which merge OVER them (#2637; nearest wins,
  // matching the executor's command-prompt path).
  inputs: Record<string, JsonValue> | undefined = ctx.inputs
): string {
  const docsDir = join(ctx.cwd, 'docs');
  return substituteWorkflowVariables(
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
    // A dry run never writes typed artifacts, so it has no listing to point at. Pass
    // an explicit empty value: the preview substitutes '' rather than throwing the way
    // a real invocation that forgot to materialize a listing does.
    {
      shellSafe: surface !== 'prompt',
      stateDir: ctx.stateDir,
      typedArtifactsFile: '',
      ...(inputs ? { inputs } : {}),
      references: nodeTemplateReferences(
        text,
        { nodeOutputs: outputs, loopBodyScopes: ctx.loopBodyScopes },
        surface
      ),
    }
  ).prompt;
}

/**
 * A minimal executor `ShellInputContext` over the simulation's state, so node-local
 * `with:` bindings resolve through the executor's OWN `resolveNodeBindings` — the
 * preview and the real run share one resolver and cannot drift (#2637). The
 * simulation has no WorkflowRun row; run inputs are passed explicitly instead of
 * riding metadata.
 */
export function bindingShellContext(
  ctx: DryRunContext,
  outputs: Map<string, NodeOutput>
): ShellInputContext {
  return {
    workflowRun: { id: 'dry-run', user_message: ctx.userMessage, metadata: {} },
    artifactsDir: ctx.artifactsDir,
    stateDir: ctx.stateDir,
    baseBranch: 'dry-run-base',
    docsDir: join(ctx.cwd, 'docs'),
    nodeOutputs: outputs,
    loopBodyScopes: ctx.loopBodyScopes,
  };
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
  const resolved = resolveNodeModelScope(node, ctx.scope, ctx.assistantModels, ctx.aiProfile);
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
export function withResolution(
  node: DagNode,
  ctx: DryRunContext
): { resolution?: DryRunResolution } {
  const resolution = resolutionFor(node, ctx);
  return resolution ? { resolution } : {};
}

export function recordSkipped(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  reason: string,
  cause: SkipCause,
  iteration?: number
): void {
  outputs.set(node.id, { state: 'skipped', output: '', cause });
  ctx.trace.push({
    nodeId: node.id,
    nodeType: nodeType(node),
    state: 'skipped',
    reason,
    cause,
    ...(iteration ? { iteration } : {}),
  });
}

export function recordFailed(
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

/**
 * Trace reason for a missing stub that `trigger_rule: all_done` tolerated (#2869).
 * Shared by the single-node gate and by `simulateLoop`, which resolves its own stub
 * and so never reaches that gate (#2966).
 */
export const TOLERATED_STUB_REASON =
  'Missing stub tolerated by trigger_rule: all_done — using a generated placeholder';

export function stubFor(node: DagNode, ctx: DryRunContext): DryRunStubValue | undefined {
  if (Object.hasOwn(ctx.stubs, node.id)) {
    ctx.consumedStubs.add(node.id);
    const authored = ctx.stubs[node.id];
    // The one place an authored stub enters a simulation, so the one place that can
    // hold its contract by construction rather than by each caller remembering to.
    if (authored !== undefined) assertAuthoredStubSatisfiesSchema(node, authored);
    return authored;
  }
  if (ctx.defaultStubs && !(isExecNode(node) && ctx.execCode)) {
    return generatedStubFor(node);
  }
  return undefined;
}
