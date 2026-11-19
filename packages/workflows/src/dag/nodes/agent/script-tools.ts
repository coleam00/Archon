import { randomUUID } from 'node:crypto';
import { nativeToolInputSchema, type NativeTool } from '@archon/provider-contract';
import type { AgentNode, ExecNode } from '../../../schemas';
import type { NodeExecutionRecord } from '../../../schemas/node-execution';
import { canonicalValueText, jsonValueSchema, type JsonValue } from '../../../output-ref';
import { validateJsonSchema } from '../../../structured-output';
import { scriptToolsCompileError } from '../../../loader/contracts';
import { persistNodeEvent } from '../../../node-event-write';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import { formatSubprocessFailure } from '../../../executor-shared';
import type { RunLayersContext } from '../../run-context';
import { prepareToolScript, runScript } from '../exec/script';
import { ExecOutputContractError } from '../exec/exec-output';
import {
  collectCredentialValues,
  containsCredentialValue,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

const STOP_GRACE_MS = 1_000;

interface ToolOutcome {
  output: JsonValue;
  status: 'completed' | 'failed' | 'unknown';
  error?: string;
  credentialValues?: readonly string[];
}

export async function createScriptTools(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  abortController: AbortController
) {
  const schemaError = scriptToolsCompileError(node);
  if (schemaError) throw new Error(schemaError);
  const pendingWrites = new Set<Promise<string>>();
  const timeoutWrites = new Set<() => Promise<void>>();
  const toolAbort = new AbortController();
  let unknownWrite: string | undefined;
  let recordingError: unknown;
  let closed = false;
  const nativeTools: NativeTool[] = [];
  for (const [name, declaration] of Object.entries(node.tools ?? {})) {
    const script: ExecNode = {
      id: node.id,
      kind: 'exec',
      runtime: 'bun',
      script: declaration.script,
      output_format: declaration.output_schema,
      timeout: declaration.timeout,
      deps: declaration.deps,
    };
    const prepared = await prepareToolScript(ctx, script, execution);
    nativeTools.push({
      name,
      description: declaration.description,
      inputSchema: nativeToolInputSchema.parse({ jsonSchema: declaration.input_schema }),
      handler: (input, context) => {
        const jsonInput = jsonValueSchema.parse(input);
        let recorded = false;
        const record = async (outcome: ToolOutcome): Promise<void> => {
          if (recorded) return;
          recorded = true;
          const credentialValues =
            outcome.credentialValues ??
            collectCredentialValues(
              prepared.env,
              ctx.config.protectedEnvKeys,
              ctx.config.protectedCredentialValues
            );
          try {
            await persistNodeEvent(ctx.deps.store, {
              workflow_run_id: ctx.workflowRun.id,
              step_name: execution.path,
              event_type: 'script_tool_call',
              data: {
                attempt_id: execution.attempt.id,
                tool_name: name,
                call_id: randomUUID(),
                ...(context ? { provider_call_id: context.providerCallId } : {}),
                ...(context?.providerCallScope
                  ? { provider_call_scope: context.providerCallScope }
                  : {}),
                status: outcome.status,
                ...auditField('input', jsonInput, credentialValues),
                ...auditField('output', outcome.output, credentialValues),
                ...(outcome.error ? auditField('error', outcome.error, credentialValues) : {}),
              },
            });
          } catch (cause) {
            recordingError ??= cause;
            abortController.abort();
            throw cause;
          }
        };
        const recordUnknown = async (error: string): Promise<void> => {
          if (recorded) return;
          unknownWrite ??= error;
          abortController.abort();
          await record({ output: null, status: 'unknown', error });
        };
        const execute = async (): Promise<ToolOutcome> => {
          const validation = validateJsonSchema(input, declaration.input_schema);
          if (!validation.valid)
            return {
              output: null,
              status: 'failed',
              error: `Invalid input: ${validation.errors.join('; ')}`,
            };
          try {
            await prepared.recheck();
          } catch (cause) {
            return { output: null, status: 'failed', error: (cause as Error).message };
          }
          if (closed || toolAbort.signal.aborted || abortController.signal.aborted) {
            const error = 'Tool attempt stopped before script start';
            if (declaration.writes) {
              unknownWrite ??= error;
              abortController.abort();
              return { output: null, status: 'unknown', error };
            }
            return { output: null, status: 'failed', error };
          }
          try {
            const result = await runScript(
              ctx,
              script,
              { ...prepared.invocation, input: JSON.stringify(input) },
              prepared.env,
              AbortSignal.any([toolAbort.signal, abortController.signal])
            );
            return {
              output:
                result.structuredOutput === undefined ? result.output : result.structuredOutput,
              status: 'completed',
              credentialValues: result.credentialValues,
            };
          } catch (cause) {
            const error =
              cause instanceof ExecOutputContractError
                ? cause.message
                : formatSubprocessFailure(cause as RawSubprocessRejection, `Tool '${name}'`)
                    .userMessage;
            if (declaration.writes && !knownScriptFailure(ctx, cause)) {
              unknownWrite ??= error;
              abortController.abort();
              return { output: null, status: 'unknown', error };
            }
            return { output: null, status: 'failed', error };
          }
        };
        const call = async (): Promise<string> => {
          if (closed || toolAbort.signal.aborted || abortController.signal.aborted)
            throw new Error('Tool attempt has stopped');
          const outcome = await execute();
          await record(outcome);
          if (outcome.error) throw new Error(outcome.error);
          return canonicalValueText(outcome.output);
        };
        const work = call();
        if (declaration.writes) {
          const timeout = () =>
            recordUnknown(
              `Tool '${name}' did not settle within ${STOP_GRACE_MS}ms after the attempt stopped; its write outcome is unknown`
            );
          pendingWrites.add(work);
          timeoutWrites.add(timeout);
          const settled = () => {
            pendingWrites.delete(work);
            timeoutWrites.delete(timeout);
          };
          void work.then(settled, settled);
        }
        return work;
      },
    });
  }
  return {
    nativeTools,
    get unknownWrite() {
      return unknownWrite;
    },
    get recordingError() {
      return recordingError;
    },
    async stop() {
      closed = true;
      toolAbort.abort();
      if (pendingWrites.size === 0) return;
      if (await exceedsGrace(Promise.allSettled([...pendingWrites]))) {
        await exceedsGrace(Promise.allSettled([...timeoutWrites].map(timeout => timeout())));
      }
    },
  };
}

async function exceedsGrace(promise: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    promise.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), STOP_GRACE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return timedOut;
}

function auditField(
  field: 'input' | 'output' | 'error',
  value: JsonValue,
  credentials: readonly string[]
): Record<string, JsonValue> {
  const redacted = redactJson(value, credentials);
  return redacted === undefined ? { [`${field}_redaction_failed`]: true } : { [field]: redacted };
}

function redactJson(value: JsonValue, credentials: readonly string[]): JsonValue | undefined {
  if (typeof value === 'string') {
    const redacted = redactCredentialValues(value, credentials);
    return containsCredentialValue(redacted, credentials) ? undefined : redacted;
  }
  if (Array.isArray(value)) {
    const redacted = value.map(item => redactJson(item, credentials));
    return redacted.every(item => item !== undefined) ? redacted : undefined;
  }
  return typeof value === 'object' && value !== null ? redactObject(value, credentials) : value;
}

function redactObject(
  value: Record<string, JsonValue>,
  credentials: readonly string[]
): JsonValue | undefined {
  const entries = Object.entries(value);
  const reserved = new Set(
    Object.keys(value).filter(key => !containsCredentialValue(key, credentials))
  );
  const output: [string, JsonValue][] = [];
  for (const [key, item] of entries) {
    const result = redactJson(item, credentials);
    if (result === undefined) return undefined;
    const name = containsCredentialValue(key, credentials)
      ? allocateRedactedKey(key, reserved, credentials, entries.length + 1)
      : key;
    if (name === undefined) return undefined;
    reserved.add(name);
    output.push([name, result]);
  }
  return Object.fromEntries(output);
}

function allocateRedactedKey(
  key: string,
  reserved: Set<string>,
  credentials: readonly string[],
  maxSuffix: number
): string | undefined {
  const base = redactCredentialValues(key, credentials);
  if (containsCredentialValue(base, credentials)) return undefined;
  if (!reserved.has(base)) return base;
  for (let suffix = 1; suffix <= maxSuffix; suffix++) {
    const candidate = `${base}#${suffix}`;
    if (!reserved.has(candidate) && !containsCredentialValue(candidate, credentials))
      return candidate;
  }
  return undefined;
}

function knownScriptFailure(ctx: RunLayersContext, cause: unknown): boolean {
  const facts = cause as RawSubprocessRejection;
  return (
    cause instanceof ExecOutputContractError ||
    hostSpawnFailure(ctx.execContext, facts) !== undefined ||
    (typeof facts.code === 'number' &&
      !facts.timedOut &&
      !facts.cancelled &&
      !facts.treeSurvived &&
      !facts.signal)
  );
}
