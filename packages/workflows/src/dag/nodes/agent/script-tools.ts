import type { NativeTool, NativeToolInputSchema } from '@archon/provider-contract';
import { redactCredentialValues } from '@archon/paths/credential-redaction';
import { z } from 'zod';
import type { AgentNode } from '../../../schemas';
import type { ScriptToolDeclaration } from '../../../schemas/provider-options';
import type { NodeExecutionRecord } from '../../../schemas/node-execution';
import type { WorkflowToolCall } from '../../../schemas/tool-call';
import { compileOutputSchema, validateStructuredOutput } from '../../../structured-output';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import {
  newToolCallId,
  foldToolCalls,
  persistToolCall,
  toolCallRef,
  writeToolCallValue,
  readToolCallValue,
  toolValueDigest,
} from '../../../tool-calls';
import { writeInvocationListings, type InvocationListings } from '../../../invocation-listings';
import { NodeFailure } from '../../ai-turn';
import type { RunLayersContext } from '../../run-context';
import { runSubprocessUntilRunStops } from '../../run-control';
import { prepareNamedScript } from '../exec/script';

const inputPropertySchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    description: z.string().optional(),
    enum: z.array(z.string()).nonempty().optional(),
  }),
  z.strictObject({ type: z.literal('boolean'), description: z.string().optional() }),
]);
const inputSchema = z.strictObject({
  type: z.literal('object'),
  properties: z.record(z.string(), inputPropertySchema),
  required: z.array(z.string()).optional(),
  additionalProperties: z.literal(false).optional(),
});

export interface ScriptToolRuntime {
  nativeTools: NativeTool[];
  settle(): Promise<void>;
  unknownOutcome(): { callId: string; error: string } | undefined;
}

export async function prepareScriptTools(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  stepName: string,
  listings: InvocationListings | undefined,
  abortSignal?: AbortSignal
): Promise<{ runtime?: ScriptToolRuntime; error?: string }> {
  if (node.tools === undefined) return {};
  if ((node.sandbox ?? ctx.workflowLevelOptions.sandbox)?.enabled === true) {
    return {
      error:
        'Script-backed tools cannot inherit the provider sandbox; remove tools or use container isolation without a provider sandbox',
    };
  }
  try {
    return {
      runtime: await buildScriptTools(
        ctx,
        node,
        execution,
        stepName,
        listings ?? (await writeInvocationListings(ctx)),
        abortSignal
      ),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function assertScriptToolsSettled(tools: ScriptToolRuntime | undefined): void {
  const unknown = tools?.unknownOutcome();
  if (unknown === undefined) return;
  throw new NodeFailure(
    'exec_failed',
    `Script tool '${unknown.callId}' has an unknown outcome: ${unknown.error}`,
    undefined,
    false
  );
}

class ToolArtifactPersistenceError extends Error {}
class ToolReceiptPersistenceError extends Error {}
class ToolProcessError extends Error {
  constructor(readonly raw: RawSubprocessRejection) {
    super(raw.message);
  }
}

type UnknownOutcome = { callId: string; error: string };
type CallResults = Map<string, { fingerprint: string; result: Promise<string> }>;
type ToolCallBase = Pick<
  WorkflowToolCall,
  | 'call_id'
  | 'run_id'
  | 'node_id'
  | 'attempt_id'
  | 'tool_name'
  | 'provider_call_id'
  | 'provider_call_scope'
  | 'node_path'
  | 'invocation_id'
  | 'loop_path'
  | 'input_ref'
  | 'input_digest'
>;
type ToolCallTransition = ToolCallBase & {
  status: WorkflowToolCall['status'];
  output_ref?: string;
  output_digest?: string;
  error?: string;
};

/** The provider-neutral native-tool subset, checked once at the Engine boundary. */
export function scriptToolNativeInput(schema: Record<string, unknown>): NativeToolInputSchema {
  const parsed = inputSchema.parse(schema);
  const required = parsed.required ?? [];
  if (!required.every(name => Object.hasOwn(parsed.properties, name))) {
    throw new Error('Tool input_schema.required names an undeclared property');
  }
  return {
    properties: Object.fromEntries(
      Object.entries(parsed.properties).map(([name, property]) => [
        name,
        property.type === 'boolean'
          ? {
              kind: 'boolean',
              ...(property.description !== undefined ? { description: property.description } : {}),
            }
          : property.enum !== undefined
            ? {
                kind: 'enum',
                values: property.enum,
                ...(property.description !== undefined
                  ? { description: property.description }
                  : {}),
              }
            : {
                kind: 'string',
                ...(property.description !== undefined
                  ? { description: property.description }
                  : {}),
              },
      ])
    ) as NativeToolInputSchema['properties'],
    required,
  };
}

export async function buildScriptTools(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  stepName: string,
  listings: InvocationListings,
  abortSignal?: AbortSignal
): Promise<ScriptToolRuntime> {
  const declarations = Object.entries(node.tools ?? {});
  let unknown: UnknownOutcome | undefined;
  const calls: CallResults = new Map();
  const replayOnly = await loadCallHistory(ctx, execution, calls, failure => {
    unknown = failure;
  });
  const nativeTools = declarations.map(([name, declaration]): NativeTool => {
    validateToolSchemas(name, declaration);
    return {
      name,
      description: declaration.description,
      inputSchema: scriptToolNativeInput(declaration.input_schema),
      handler: (input, context) =>
        dispatchScriptTool(ctx, node, execution, stepName, listings, name, declaration, input, {
          context,
          calls,
          replayOnly,
          abortSignal,
          setUnknown: failure => {
            unknown = failure;
          },
          hasUnknown: () => unknown !== undefined,
        }),
    };
  });
  return {
    nativeTools,
    settle: async () => {
      await Promise.allSettled([...calls.values()].map(call => call.result));
    },
    unknownOutcome: () => unknown,
  };
}

function validateToolSchemas(name: string, declaration: ScriptToolDeclaration): void {
  for (const schema of [declaration.input_schema, declaration.output_schema]) {
    const compileError = compileOutputSchema(schema);
    if (compileError !== null) throw new Error(`Tool '${name}': ${compileError}`);
  }
}

async function loadCallHistory(
  ctx: RunLayersContext,
  execution: NodeExecutionRecord,
  calls: CallResults,
  setUnknown: (failure: UnknownOutcome) => void
): Promise<boolean> {
  let replayOnly = false;
  const events =
    (await ctx.deps.store.listEventsForRuns([ctx.workflowRun.id], ['workflow_tool_call'])).get(
      ctx.workflowRun.id
    ) ?? [];
  for (const call of foldToolCalls(events, ctx.workflowRun.id).filter(
    call =>
      (call.node_path ?? call.node_id) === execution.path &&
      (call.invocation_id === undefined ||
        call.invocation_id === execution.invocation.id ||
        JSON.stringify(call.loop_path) === JSON.stringify(execution.invocation.loopPath) ||
        call.status === 'started' ||
        call.status === 'outcome_unknown')
  )) {
    if (call.status === 'completed' && call.attempt_id !== execution.attempt.id) replayOnly = true;
    let inputText: string;
    try {
      inputText = await readToolCallValue(ctx.artifactsDir, call.input_ref, call.input_digest);
    } catch {
      setUnknown({
        callId: call.call_id,
        error: 'Recorded tool input failed integrity verification',
      });
      continue;
    }
    const input = JSON.parse(inputText);
    const fingerprint = JSON.stringify([call.tool_name, input]);
    const result = historicalResult(ctx, call, setUnknown);
    await result.catch(() => undefined);
    const key = JSON.stringify([call.provider_call_scope ?? '', call.provider_call_id]);
    if (calls.has(key)) {
      throw new Error(`Provider call '${call.provider_call_id}' has conflicting receipts`);
    }
    calls.set(key, { fingerprint, result });
  }
  return replayOnly;
}

function historicalResult(
  ctx: RunLayersContext,
  call: ReturnType<typeof foldToolCalls>[number],
  setUnknown: (failure: UnknownOutcome) => void
): Promise<string> {
  if (call.status === 'completed' && call.output_ref !== undefined) {
    return readToolCallValue(ctx.artifactsDir, call.output_ref, call.output_digest).catch(() => {
      const error = `Recorded output for tool call '${call.call_id}' failed integrity verification`;
      setUnknown({ callId: call.call_id, error });
      throw new Error(error);
    });
  }
  const error =
    call.status === 'failed'
      ? `Tool call '${call.call_id}' already failed: ${call.error ?? 'unknown error'}`
      : `Tool call '${call.call_id}' has no safe result to replay`;
  if (call.status !== 'failed') setUnknown({ callId: call.call_id, error });
  return Promise.reject(new Error(error));
}

function dispatchScriptTool(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  stepName: string,
  listings: InvocationListings,
  name: string,
  declaration: ScriptToolDeclaration,
  input: Record<string, unknown>,
  state: {
    context: { providerCallId: string; providerCallScope?: string } | undefined;
    calls: CallResults;
    replayOnly: boolean;
    abortSignal?: AbortSignal;
    setUnknown(failure: UnknownOutcome): void;
    hasUnknown(): boolean;
  }
): Promise<string> {
  if (state.abortSignal?.aborted)
    return Promise.reject(new Error('Agent attempt has ended; no script tool will start'));
  if (state.context?.providerCallId === undefined) {
    return Promise.reject(new Error(`Provider did not identify the call to '${name}'`));
  }
  const { providerCallId, providerCallScope } = state.context;
  const fingerprint = JSON.stringify([name, input]);
  const key = JSON.stringify([providerCallScope ?? '', providerCallId]);
  const existing = state.calls.get(key);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      return Promise.reject(
        new Error(`Provider call '${providerCallId}' was reused for different tool input`)
      );
    }
    return existing.result;
  }
  if (state.replayOnly) {
    const error =
      'A previous attempt completed a script tool; a new provider call cannot safely replay it';
    state.setUnknown({ callId: providerCallId, error });
    return Promise.reject(new Error(error));
  }
  const result = invokeScriptTool(ctx, node, execution, stepName, listings, name, declaration, {
    callId: newToolCallId(),
    providerCallId,
    providerCallScope,
    input,
    setUnknown: state.setUnknown,
    hasUnknown: state.hasUnknown,
    abortSignal: state.abortSignal,
  });
  state.calls.set(key, { fingerprint, result });
  return result;
}

async function invokeScriptTool(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  stepName: string,
  listings: InvocationListings,
  name: string,
  declaration: ScriptToolDeclaration,
  state: {
    callId: string;
    providerCallId: string;
    providerCallScope?: string;
    input: Record<string, unknown>;
    setUnknown(failure: { callId: string; error: string }): void;
    hasUnknown(): boolean;
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  if (state.hasUnknown()) {
    throw new Error('An earlier script tool has an unknown outcome; no further tool will start');
  }
  assertToolValue(state.input, declaration.input_schema, name, 'input');

  const inputRef = toolCallRef(state.callId, 'input.json');
  const base = {
    call_id: state.callId,
    run_id: ctx.workflowRun.id,
    node_id: node.id,
    attempt_id: execution.attempt.id,
    tool_name: name,
    provider_call_id: state.providerCallId,
    ...(state.providerCallScope !== undefined
      ? { provider_call_scope: state.providerCallScope }
      : {}),
    node_path: execution.path,
    invocation_id: execution.invocation.id,
    loop_path: execution.invocation.loopPath,
    input_ref: inputRef,
    input_digest: toolValueDigest(JSON.stringify(state.input)),
  } as const;
  let processStarted = false;
  try {
    return await executeAndRecordTool(ctx, node, execution, stepName, listings, name, declaration, {
      base,
      input: state.input,
      onProcessStart: () => {
        state.abortSignal?.throwIfAborted();
        if (state.hasUnknown())
          throw new Error(
            'An earlier script tool has an unknown outcome; no further tool will start'
          );
        processStarted = true;
      },
      abortSignal: state.abortSignal,
    });
  } catch (error) {
    await recordToolFailure(ctx, stepName, base, error, processStarted, state.setUnknown);
    throw error;
  }
}

function assertToolValue(
  value: unknown,
  schema: Record<string, unknown>,
  name: string,
  kind: 'input' | 'output'
): void {
  let compileError: string | undefined;
  const validation = validateStructuredOutput(value, schema, error => {
    compileError = error;
  });
  if (compileError !== undefined)
    throw new Error(`Tool '${name}' ${kind} schema cannot be enforced`);
  if (!validation.valid) {
    const suffix = kind === 'input' ? ' before script start' : ' did not satisfy its schema';
    throw new Error(`Tool '${name}' ${kind}${suffix}`);
  }
}

async function executeAndRecordTool(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  stepName: string,
  listings: InvocationListings,
  name: string,
  declaration: ScriptToolDeclaration,
  state: {
    base: ToolCallBase;
    input: Record<string, unknown>;
    onProcessStart(): void;
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  await writeToolArtifact(ctx, state.base.input_ref, state.input, name, 'input');
  await persistTransition(ctx, stepName, { ...state.base, status: 'started' });
  const stdout = await runToolProcess(
    ctx,
    node,
    execution,
    stepName,
    listings,
    name,
    declaration,
    state
  );
  const value = parseToolOutput(stdout, name);
  assertToolValue(value, declaration.output_schema, name, 'output');
  const outputRef = toolCallRef(state.base.call_id, 'output.json');
  await writeToolArtifact(ctx, outputRef, value, name, 'output');
  await persistTransition(ctx, stepName, {
    ...state.base,
    output_ref: outputRef,
    output_digest: toolValueDigest(JSON.stringify(value)),
    status: 'completed',
  });
  return JSON.stringify(value);
}

async function runToolProcess(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  stepName: string,
  listings: InvocationListings,
  name: string,
  declaration: ScriptToolDeclaration,
  state: {
    base: { call_id: string };
    input: Record<string, unknown>;
    onProcessStart(): void;
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  const prepared = await prepareNamedScript(
    ctx,
    node,
    declaration.script,
    stepName,
    execution,
    listings
  );
  const { command, args, input: stdin } = prepared.invocation;
  state.onProcessStart();
  try {
    const { stdout, credentialValues } = await runSubprocessUntilRunStops(
      ctx.deps.store,
      ctx.workflowRun.id,
      node.id,
      ctx.execContext,
      command,
      args,
      {
        cwd: ctx.cwd,
        timeout: declaration.timeout,
        endTreeOnTimeout: true,
        input: stdin,
        abortSignal: state.abortSignal,
        env: {
          ...prepared.env,
          ARCHON_TOOL_CALL_ID: state.base.call_id,
          ARCHON_TOOL_INPUT: JSON.stringify(state.input),
        },
        protectedEnvKeys: ctx.config.protectedEnvKeys,
        protectedCredentialValues: ctx.config.protectedCredentialValues,
        retention: {
          logDir: ctx.logDir,
          workflowRunId: ctx.workflowRun.id,
          nodeId: node.id,
          label: `<tool:${name}:${state.base.call_id}>`,
        },
      }
    );
    return redactCredentialValues(stdout, credentialValues);
  } catch (error) {
    throw new ToolProcessError(error as RawSubprocessRejection);
  }
}

function parseToolOutput(stdout: string, name: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Tool '${name}' stdout was not one JSON document`);
  }
}

async function writeToolArtifact(
  ctx: RunLayersContext,
  ref: string,
  value: unknown,
  name: string,
  kind: 'input' | 'output'
): Promise<void> {
  try {
    await writeToolCallValue(ctx.artifactsDir, ref, value);
  } catch (error) {
    throw new ToolArtifactPersistenceError(
      `Tool '${name}' could not persist its ${kind}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function persistTransition(
  ctx: RunLayersContext,
  stepName: string,
  transition: ToolCallTransition
): Promise<void> {
  try {
    await persistToolCall(ctx.deps.store, stepName, {
      ...transition,
      recorded_at: new Date().toISOString(),
    });
  } catch (error) {
    throw new ToolReceiptPersistenceError(error instanceof Error ? error.message : String(error));
  }
}

async function recordToolFailure(
  ctx: RunLayersContext,
  stepName: string,
  base: ToolCallBase,
  error: unknown,
  processStarted: boolean,
  setUnknown: (failure: UnknownOutcome) => void
): Promise<void> {
  const raw = error instanceof ToolProcessError ? error.raw : (error as RawSubprocessRejection);
  const receiptFailed = error instanceof ToolReceiptPersistenceError;
  const uncertain =
    receiptFailed ||
    error instanceof ToolArtifactPersistenceError ||
    (processStarted &&
      !(error instanceof ToolProcessError && hostSpawnFailure(ctx.execContext, raw) !== undefined));
  const message = redactCredentialValues(
    error instanceof Error ? error.message : String(error),
    ctx.config.protectedCredentialValues ?? []
  ).slice(0, 500);
  if (uncertain) setUnknown({ callId: base.call_id, error: message });
  // A failed receipt write cannot be repaired by another transition whose commit is also uncertain.
  if (receiptFailed) return;
  try {
    await persistTransition(ctx, stepName, {
      ...base,
      status: uncertain ? 'outcome_unknown' : 'failed',
      error: message,
    });
  } catch (persistenceError) {
    setUnknown({
      callId: base.call_id,
      error:
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
    });
  }
}
