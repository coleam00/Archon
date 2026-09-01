/** Side-effect-free workflow DAG simulation with caller-supplied node outputs. */
import { z } from '@hono/zod-openapi';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { createLogger, getArchonTempPath } from '@archon/paths';
import { validateStructuredOutput } from '@archon/providers/structured-output';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  checkComposedBlockBoundaries,
  checkTriggerRule,
  resolveNodeBindings,
  substituteNodeOutputRefs,
  type ShellInputContext,
} from './dag-executor';
import { planGraph, resolvedBodyNodes } from './graph-plan';
import { evaluateCondition } from './condition-evaluator';
import {
  COMPILED_LOOP_COMMAND,
  readComposedBindings,
  type LoopWithCompiledCommand,
} from './compiled-command';
import { declaredFieldsFromSchema, canonicalValueText, type JsonValue } from './output-ref';
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
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import { defaultRunInputs } from './workflow-inputs';
import { buildExecNodeEnvironment } from './exec-environment';
import {
  inputEnvKey,
  isGateNode,
  isExecNode,
  isHaltNode,
  isAgentNode,
  isComposeFanOutNode,
  isLoopGroupNode,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
  effortLevelSchema,
  type DagNode,
  type NodeOutput,
  type GraphPlan,
  type ResolvedWorkflow,
} from './schemas';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('workflow.dry-run');
  return cachedLog;
}

export const dryRunStubValueSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type DryRunStubValue = z.infer<typeof dryRunStubValueSchema>;
export const dryRunStubsSchema = z.unknown().transform((value, ctx) => {
  if (!isRecord(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'expected a mapping of node ids to outputs',
    });
    return z.NEVER;
  }

  const entries: [string, DryRunStubValue][] = [];
  let invalid = false;
  for (const [id, candidate] of Object.entries(value)) {
    const result = dryRunStubValueSchema.safeParse(candidate);
    if (!result.success) {
      invalid = true;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id],
        message: result.error.issues.map(issue => issue.message).join('; '),
      });
      continue;
    }
    // Validation establishes the union; retaining the raw value preserves own keys
    // such as `__proto__` across the YAML → Zod boundary.
    entries.push([id, candidate as DryRunStubValue]);
  }
  return invalid ? z.NEVER : Object.fromEntries(entries);
});
export type DryRunStubs = z.infer<typeof dryRunStubsSchema>;

/** Reserved keys of the `.stubs.yaml` fixture format (#2772); `loadDryRunStubs` rejects them so a fixture file is never mis-read as plain stubs. */
export const RESERVED_FIXTURE_KEYS = new Set(['fixture', 'exec-code']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStubValue(value: unknown): value is DryRunStubValue {
  return dryRunStubValueSchema.safeParse(value).success;
}

function schemaPlaceholder(schema: unknown): unknown {
  if (!isRecord(schema)) return 'TODO';

  if ('const' in schema) return structuredClone(schema.const);
  if ('default' in schema) return structuredClone(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(schema.enum[0]);
  }

  switch (schema.type) {
    case 'object': {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === 'string')
        : [];
      return Object.fromEntries(required.map(name => [name, schemaPlaceholder(properties[name])]));
    }
    case 'array': {
      const minItems =
        typeof schema.minItems === 'number' && Number.isInteger(schema.minItems)
          ? Math.max(0, schema.minItems)
          : 0;
      return Array.from({ length: minItems }, () => schemaPlaceholder(schema.items));
    }
    case 'boolean':
      return false;
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 0;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'null':
      return null;
    case 'string': {
      const minLength =
        typeof schema.minLength === 'number' && Number.isInteger(schema.minLength)
          ? Math.max(0, schema.minLength)
          : 0;
      return minLength > 4 ? 'T'.repeat(minLength) : 'TODO';
    }
    default:
      return 'TODO';
  }
}

function generatedStubFor(node: DagNode): DryRunStubValue {
  if (node.output_format === undefined) {
    return isLoopNode(node) && node.loop.until !== undefined ? node.loop.until : 'TODO';
  }
  if (node.output_format.$async === true) {
    throw new Error(
      `Cannot generate dry-run stub for node '${node.id}': asynchronous output_format schemas are unsupported`
    );
  }

  const value = schemaPlaceholder(node.output_format);
  if (isLoopNode(node) && node.loop.until_field !== undefined) {
    if (!isRecord(value)) {
      throw new Error(
        `Cannot generate dry-run stub for node '${node.id}': loop.until_field requires an object-typed output_format`
      );
    }
    value[node.loop.until_field] = true;
  }

  let compileError: string | undefined;
  const validation = validateStructuredOutput(value, node.output_format, message => {
    compileError = message;
  });
  if (compileError !== undefined) {
    throw new Error(
      `Cannot generate dry-run stub for node '${node.id}': output_format could not be compiled (${compileError})`
    );
  }
  if (!validation.valid) {
    throw new Error(
      `Cannot generate schema-valid dry-run stub for node '${node.id}': ${validation.errors.join('; ')}`
    );
  }
  if (!isStubValue(value)) {
    throw new Error(
      `Cannot generate dry-run stub for node '${node.id}': output_format produced a placeholder of an unsupported type`
    );
  }
  return value;
}

function stubSatisfiesNode(node: DagNode, stub: DryRunStubValue): boolean {
  if (node.output_format !== undefined) {
    const validation = validateStructuredOutput(stub, node.output_format);
    if (!validation.valid) return false;
  }
  if (isLoopNode(node)) {
    return loopIterationCompletes(node.loop, completedOutput(node, stub)).kind !== 'incomplete';
  }
  return true;
}

function collectsStub(node: DagNode): boolean {
  // `include:` is no longer a DagNode member (#2486) — it never reaches this function.
  return !(
    isGateNode(node) ||
    isWaitNode(node) ||
    isHaltNode(node) ||
    isWorkflowNode(node) ||
    isComposeFanOutNode(node) ||
    isLoopGroupNode(node)
  );
}

/** Build the complete static stub map for an already-expanded workflow definition. */
export function createDryRunStubScaffold(workflow: ResolvedWorkflow): DryRunStubs {
  const stubs = new Map<string, { candidates: DryRunStubValue[]; consumers: DagNode[] }>();
  const visit = (nodes: readonly DagNode[]): void => {
    for (const node of nodes) {
      if (collectsStub(node)) {
        const generated = generatedStubFor(node);
        const existing = stubs.get(node.id);
        if (existing === undefined) {
          stubs.set(node.id, { candidates: [generated], consumers: [node] });
        } else {
          existing.candidates.push(generated);
          existing.consumers.push(node);
        }
      }
      if (isLoopGroupNode(node)) visit(resolvedBodyNodes(node.loop_group));
    }
  };
  visit(workflow.nodes);
  return Object.fromEntries(
    [...stubs].map(([id, entry]) => {
      const value = entry.candidates.find(candidate =>
        entry.consumers.every(consumer => stubSatisfiesNode(consumer, candidate))
      );
      if (value === undefined) {
        throw new Error(
          `Cannot generate dry-run scaffold: nodes sharing stub key '${id}' require incompatible values`
        );
      }
      return [id, value];
    })
  );
}

/** Write a scaffold without ever overwriting an existing fixture. */
export async function writeDryRunStubScaffold(
  workflow: ResolvedWorkflow,
  path: string
): Promise<DryRunStubs> {
  const stubs = createDryRunStubScaffold(workflow);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, 'wx');
    await handle.writeFile(Bun.YAML.stringify(stubs));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      throw new Error(`Dry-run stub scaffold already exists: ${path}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return stubs;
}

const dryRunNodeTypeSchema = z.enum([
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'loop_group',
  'approval',
  'wait',
  'cancel',
  'include',
  'workflow',
  'compose_fan_out',
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
  effort: effortLevelSchema.optional(),
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
  /**
   * The subset of `missingStubs` a `trigger_rule: all_done` join tolerated (#2869) —
   * hydrated with a generated placeholder rather than failing the node. Always a
   * subset of `missingStubs`, never a replacement for it: a consumer that only cares
   * about genuinely blocking gaps filters `missingStubs` by this list; one that wants
   * every unverified node (the pre-#2869 contract) keeps reading `missingStubs` alone.
   */
  toleratedMissingStubs: z.array(z.string()),
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
  const reservedHit = Object.keys(parsed as Record<string, unknown>).find(key =>
    RESERVED_FIXTURE_KEYS.has(key)
  );
  if (reservedHit !== undefined) {
    throw new Error(
      `Invalid dry-run stub file '${path}': contains the fixture key '${reservedHit}' — this is a fixture file; run it with 'workflow test'`
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
  /**
   * The run's EFFECTIVE `$INPUTS` map — declared defaults layered under caller-supplied
   * values, the same merge a real run performs at executor.ts (`defaultRunInputs`).
   * Undefined when the workflow declares no inputs and the caller supplied none.
   * Values are logical JSON values (#2637 — a typed declared default stays typed).
   */
  inputs?: Record<string, JsonValue>;
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
  /** Workflow-level provider/model fallbacks, for the per-node resolution report. */
  scope: WorkflowModelScope;
  assistantModels: Readonly<Record<string, string | undefined>>;
  aiProfile?: ResolvedAiProfile;
}

async function loadDryRunCommand(ctx: DryRunContext, command: string): Promise<string> {
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
  return result.content;
}

function resolveText(
  text: string,
  ctx: DryRunContext,
  outputs: Map<string, NodeOutput>,
  shellSafe = false,
  loopPrevOutput = '',
  escapeNodeOutputs = shellSafe,
  // The `$INPUTS` bag for this text — run-level inputs unless the node carries
  // node-local `with:` bindings, which merge OVER them (#2637; nearest wins,
  // matching the executor's command-prompt path).
  inputs: Record<string, JsonValue> | undefined = ctx.inputs
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
    { shellSafe, stateDir: ctx.stateDir, ...(inputs ? { inputs } : {}) }
  ).prompt;
  return substituteNodeOutputRefs(substituted, outputs, escapeNodeOutputs);
}

/**
 * A minimal executor `ShellInputContext` over the simulation's state, so node-local
 * `with:` bindings resolve through the executor's OWN `resolveNodeBindings` — the
 * preview and the real run share one resolver and cannot drift (#2637). The
 * simulation has no WorkflowRun row; run inputs are passed explicitly instead of
 * riding metadata.
 */
function bindingShellContext(
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
  ctx: DryRunContext,
  /** Resolved node-local `with:` bindings (#2637) — the nearest env source, layered
   *  over run inputs exactly like the executor's `inputEnvVars` third tier. */
  nodeBindings?: Record<string, JsonValue>
): Promise<{ output: string } | { error: string }> {
  try {
    let command: string;
    let args: string[];
    if (!isExecNode(node)) {
      return { error: `Node '${node.id}' is not executable code` };
    } else if (node.runtime === 'sh') {
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
      const script = (await discoverScriptsForCwd(ctx.cwd, ctx.sourceRoots)).get(code);
      if (!script) return { error: `Named script '${code}' was not found` };
      command = script.runtime === 'bun' ? 'bun' : 'uv';
      args =
        script.runtime === 'bun'
          ? ['--no-env-file', 'run', script.path]
          : ['run', ...(node.deps ?? []).flatMap(dep => ['--with', dep]), script.path];
    }
    // Run-level inputs and node-local bindings ride the env bag as
    // `INPUTS_<UPPER_SNAKE>`, never text substitution — the outer tiers of a real
    // run's `inputEnvVars` (dag-executor.ts), bindings layered over run inputs in
    // the same nearest-wins order. Composed include-block inputs for named scripts
    // remain a real-run-only channel the dry run does not deliver.
    // That applies to EVERY composed exec node, not just named scripts: a
    // `bash:` body inlined through `include:` sees none of the caller's `with:`
    // values here, so one reading `$INPUTS_FOO` under `set -u` dies on an
    // unbound variable. Such a node can only be stubbed in a fixture — its real
    // behaviour is not reachable from `workflow test`.
    const inputEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(ctx.inputs ?? {})) {
      inputEnv[inputEnvKey(name)] = canonicalValueText(value);
    }
    for (const [name, value] of Object.entries(nodeBindings ?? {})) {
      inputEnv[inputEnvKey(name)] = canonicalValueText(value);
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
        }),
      },
    });
    return { output: result.stdout.replace(/\n$/, '') };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return { error: err.stderr?.trim() || err.message };
  }
}

/**
 * Trace reason for a missing stub that `trigger_rule: all_done` tolerated (#2869).
 * Shared by the single-node gate and by `simulateLoop`, which resolves its own stub
 * and so never reaches that gate (#2966).
 */
const TOLERATED_STUB_REASON =
  'Missing stub tolerated by trigger_rule: all_done — using a generated placeholder';

function stubFor(node: DagNode, ctx: DryRunContext): DryRunStubValue | undefined {
  if (Object.hasOwn(ctx.stubs, node.id)) {
    ctx.consumedStubs.add(node.id);
    return ctx.stubs[node.id];
  }
  if (ctx.defaultStubs && !(isExecNode(node) && ctx.execCode)) {
    return generatedStubFor(node);
  }
  return undefined;
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
  let template: string;
  if (node.loop.prompt !== undefined) {
    template = node.loop.prompt;
  } else {
    const command = node.loop.command ?? '';
    const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    const hasCompiledError = compiled !== undefined && typeof compiled.error === 'string';
    const hasCompiledPrompt = compiled !== undefined && typeof compiled.prompt === 'string';
    if (hasCompiledError && !hasCompiledPrompt) {
      throw new Error(compiled.error);
    }
    if (hasCompiledPrompt && !hasCompiledError) {
      template = compiled.prompt;
    } else if (compiled !== undefined) {
      throw new Error(
        `Loop node '${node.id}' has malformed compiled command metadata for '${command}' — expected exactly one string prompt or error.`
      );
    } else {
      template = await loadDryRunCommand(ctx, command);
    }
  }
  let resolvedText = template;
  for (let current = 1; current <= node.loop.max_iterations; current++) {
    resolvedText = resolveText(template, ctx, outputs, false, previous);
    const stub = stubFor(node, ctx);
    if (stub === undefined) {
      ctx.missingStubs.add(node.id);
      if (node.trigger_rule !== 'all_done') {
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
      // Same tolerance the single-node gate applies (#2869), extended to the loop
      // shape that never reaches it (#2966). One placeholder covers every iteration —
      // `stubFor` is constant for this node — so the question of "which iteration's
      // stub" collapses: `generatedStubFor` builds a loop placeholder that satisfies
      // the node's own completion channel, so a tolerated loop always ends on
      // iteration 1, and never runs a second one.
      const placeholder = completedOutput(node, generatedStubFor(node));
      const toleratedCompletion = loopIterationCompletes(node.loop, placeholder);
      if (toleratedCompletion.kind === 'incomplete') {
        // The tolerance claim waits for a placeholder that actually carries the node,
        // exactly as the join gate waits for one that can be generated at all. A
        // placeholder that ends no iteration would burn `max_iterations` and fail —
        // calling that tolerated would let `checkFixture` filter away the real blocker.
        recordFailed(
          node,
          outputs,
          ctx,
          `Missing reachable stub for node '${node.id}' — trigger_rule: all_done cannot tolerate it: a generated placeholder would run to max_iterations ${describeUnmetCompletion(node.loop)}`,
          resolvedText,
          iteration
        );
        return;
      }
      ctx.toleratedMissingStubs.add(node.id);
      outputs.set(node.id, placeholder);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'loop',
        state: 'stubbed',
        reason: `${TOLERATED_STUB_REASON}; ${completionReason(toleratedCompletion, node.loop, current)}`,
        resolvedText,
        output: placeholder.output,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
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
  const bodyNodes = resolvedBodyNodes(node.loop_group);
  const bodyPlan = planGraph(bodyNodes);
  let lastOutput = '';
  for (let current = 1; current <= node.loop_group.max_iterations; current++) {
    const bodyOutputs = new Map(outputs);
    await simulateNodes(bodyPlan, bodyOutputs, ctx, current);
    lastOutput =
      bodyPlan.sinks
        .map(bodyId => bodyOutputs.get(bodyId))
        .find(output => output?.state === 'completed' && output.output.trim())?.output ?? '';
    const failed = bodyNodes.some(body => bodyOutputs.get(body.id)?.state === 'failed');
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
  if (checkComposedBlockBoundaries(node, outputs, ctx.inputs) === 'skip') {
    recordSkipped(node, outputs, ctx, 'trigger_rule', iteration);
    return;
  }
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
    if (isWaitNode(node)) {
      outputs.set(node.id, { state: 'pending', output: '' });
      ctx.trace.push({
        nodeId: node.id,
        nodeType: 'wait',
        state: 'paused',
        reason: 'durable wait',
        ...(iteration ? { iteration } : {}),
      });
      ctx.halted = 'paused';
      return;
    }
    if (isGateNode(node)) {
      const resolvedText = resolveText(node.message, ctx, outputs);
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
    if (isHaltNode(node)) {
      const resolvedText = resolveText(node.reason, ctx, outputs);
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
    if (isWorkflowNode(node) || isComposeFanOutNode(node)) {
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

    const sourceText = isAgentNode(node)
      ? node.source.kind === 'command'
        ? await loadDryRunCommand(ctx, node.source.name)
        : node.source.prompt
      : isExecNode(node)
        ? node.script
        : '';
    // Node-local `with:` bindings (#2637) resolve BEFORE the stub check, exactly as
    // the executor resolves them before execution — a binding a real run would fail
    // on (unknown producer, skipped without if_skipped) fails the simulated node
    // with the executor's own error, via the catch below. Command bindings merge
    // over run inputs into the `$INPUTS` bag; script bindings ride the exec env.
    // A composed command node carries its map in the engine-private payload, having
    // been materialized into an inline prompt at expansion (#2964).
    const nodeWith = isExecNode(node)
      ? node.with
      : isAgentNode(node)
        ? node.source.kind === 'command'
          ? node.source.with
          : readComposedBindings(node)
        : undefined;
    const nodeBindings =
      nodeWith !== undefined
        ? resolveNodeBindings(node.id, nodeWith, bindingShellContext(ctx, outputs), ctx.inputs)
        : undefined;
    const commandInputs =
      isAgentNode(node) && nodeBindings !== undefined
        ? { ...(ctx.inputs ?? {}), ...nodeBindings }
        : undefined;
    const resolvedText =
      isExecNode(node) && node.runtime !== 'sh'
        ? resolveText(sourceText, ctx, outputs, true, '', false)
        : resolveText(
            sourceText,
            ctx,
            outputs,
            isExecNode(node) && node.runtime === 'sh',
            '',
            undefined,
            commandInputs
          );
    const stub = stubFor(node, ctx);
    if (stub === undefined && isExecNode(node) && ctx.execCode) {
      const executed = await executeCodeNode(node, resolvedText, ctx, nodeBindings);
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
    // `trigger_rule: all_done` declares this node a barrier/join that runs regardless
    // of upstream outcome — a real run reaches it independent of dry-run fixture data,
    // so a missing stub here is an authoring gap, not evidence the simulated run would
    // fail (#2869). Tolerate it the way `--default-stubs` tolerates any missing stub —
    // a generated placeholder — while still reporting the gap via `missingStubs` (and,
    // since the gap never blocks this node, `toleratedMissingStubs`) so the fixture
    // stays honest about what it never verified.
    const tolerated = stub === undefined && node.trigger_rule === 'all_done';
    if (stub !== undefined || tolerated) {
      if (tolerated) ctx.missingStubs.add(node.id);
      // The tolerance claim waits for the placeholder to exist. `generatedStubFor`
      // throws on an `output_format` it cannot satisfy, and the catch around this
      // whole body then fails the node — so a node added to `toleratedMissingStubs`
      // any earlier would report a gap that never blocked it while that gap is
      // exactly what blocked it, and `checkFixture` would filter the blocker away.
      const hydrated = completedOutput(node, stub ?? generatedStubFor(node));
      if (tolerated) ctx.toleratedMissingStubs.add(node.id);
      outputs.set(node.id, hydrated);
      ctx.trace.push({
        nodeId: node.id,
        nodeType: nodeType(node),
        state: 'stubbed',
        ...(tolerated ? { reason: TOLERATED_STUB_REASON } : {}),
        resolvedText,
        output: hydrated.output,
        ...(iteration ? { iteration } : {}),
        ...withResolution(node, ctx),
      });
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
  plan: GraphPlan,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): Promise<void> {
  for (const layer of plan.layers) {
    for (const node of layer) {
      if (ctx.halted) return;
      await simulateNode(node, outputs, ctx, iteration);
    }
  }
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
    ...(inputs ? { inputs } : {}),
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
      options.config?.assistant ?? 'claude',
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
  lines.push('', `Outcome: ${result.outcome}`);
  if (result.missingStubs.length > 0)
    lines.push(`Missing stubs: ${result.missingStubs.join(', ')}`);
  if (result.unusedStubs.length > 0) lines.push(`Unused stubs: ${result.unusedStubs.join(', ')}`);
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  return lines.join('\n');
}
