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
                input: redactJson(jsonInput, credentialValues),
                output: redactJson(outcome.output, credentialValues),
                ...(outcome.error
                  ? { error: redactCredentialValues(outcome.error, credentialValues) }
                  : {}),
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

function redactJson(value: JsonValue, credentialValues: readonly string[]): JsonValue {
  if (typeof value === 'string') return redactCredentialValues(value, credentialValues);
  if (Array.isArray(value)) return value.map(item => redactJson(item, credentialValues));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, credentialValues)])
    );
  }
  return value;
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
