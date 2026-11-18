import { randomUUID } from 'node:crypto';
import { nativeToolInputSchema, type NativeTool } from '@archon/provider-contract';
import type { AgentNode, ExecNode } from '../../../schemas';
import type { NodeExecutionRecord } from '../../../schemas/node-execution';
import { nodeOutputSchema } from '../../../schemas/tool-output';
import {
  canonicalValueText,
  declaredOutputPathsFromSchema,
  jsonValueSchema,
  type JsonValue,
} from '../../../output-ref';
import { validateJsonSchema } from '../../../structured-output';
import { scriptToolsCompileError } from '../../../loader/contracts';
import { persistNodeEvent } from '../../../node-event-write';
import { hostSpawnFailure, type RawSubprocessRejection } from '../../../subprocess';
import { formatSubprocessFailure } from '../../../executor-shared';
import type { RunLayersContext } from '../../run-context';
import { prepareToolScript, runScript } from '../exec/script';
import { ExecOutputContractError } from '../exec/exec-output';

export async function createScriptTools(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord,
  abortController: AbortController
) {
  const schemaError = scriptToolsCompileError(node);
  if (schemaError) throw new Error(schemaError);
  const calls: JsonValue[] = [];
  const pendingWrites = new Set<Promise<string>>();
  const toolAbort = new AbortController();
  let unknownWrite: string | undefined;
  let recordingError: unknown;
  let closed = false;
  let sequence = 0;
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
        const index = sequence++;
        const execute = async (): Promise<{
          output: JsonValue;
          status: 'completed' | 'failed' | 'unknown';
          error?: string;
        }> => {
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
          try {
            const result = await runScript(
              ctx,
              script,
              prepared.invocation,
              { ...prepared.env, ARCHON_TOOL_INPUT: JSON.stringify(input) },
              AbortSignal.any([toolAbort.signal, abortController.signal])
            );
            return { output: result.structuredOutput ?? result.output, status: 'completed' };
          } catch (cause) {
            const error =
              cause instanceof ExecOutputContractError
                ? cause.message
                : formatSubprocessFailure(cause as RawSubprocessRejection, `Tool '${name}'`)
                    .userMessage;
            const status =
              declaration.writes && !knownScriptFailure(ctx, cause) ? 'unknown' : 'failed';
            if (status === 'unknown') {
              unknownWrite = error;
              abortController.abort();
            }
            return { output: null, status, error };
          }
        };
        const call = async (): Promise<string> => {
          if (closed || toolAbort.signal.aborted || abortController.signal.aborted)
            throw new Error('Tool attempt has stopped');
          const { output, status, error } = await execute();
          const record = {
            tool_name: name,
            call_id: randomUUID(),
            ...(context ? { provider_call_id: context.providerCallId } : {}),
            ...(context?.providerCallScope
              ? { provider_call_scope: context.providerCallScope }
              : {}),
            status,
            input: jsonInput,
            output,
            ...(error ? { error } : {}),
          };
          try {
            await persistNodeEvent(ctx.deps.store, {
              workflow_run_id: ctx.workflowRun.id,
              step_name: execution.path,
              event_type: 'script_tool_call',
              data: { attempt_id: execution.attempt.id, ...record },
            });
          } catch (cause) {
            recordingError = cause;
            abortController.abort();
            throw cause;
          }
          calls[index] = record;
          if (error) throw new Error(error);
          return canonicalValueText(output);
        };
        const work = call();
        if (declaration.writes) {
          pendingWrites.add(work);
          void work.then(
            () => pendingWrites.delete(work),
            () => pendingWrites.delete(work)
          );
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
      await Promise.allSettled([...pendingWrites]);
    },
    output(result: { output: string; structuredOutput?: unknown }) {
      const value =
        result.structuredOutput === undefined
          ? result.output
          : jsonValueSchema.parse(result.structuredOutput);
      const structuredOutput =
        node.output_format?.type === 'object' &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
          ? { ...value, tool_calls: calls.filter(Boolean) }
          : { result: value, tool_calls: calls.filter(Boolean) };
      return {
        output: canonicalValueText(structuredOutput),
        structuredOutput,
        declaredOutputPaths: declaredOutputPathsFromSchema(nodeOutputSchema(node)),
      };
    },
  };
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
