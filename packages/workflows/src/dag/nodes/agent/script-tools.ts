/**
 * Tools an agent node declares under `tools:`. Each becomes a provider-native tool whose
 * call runs a named script the way a `script:` node runs it: the arguments as JSON on
 * stdin, stdout as the result. The engine validates both sides and records every call.
 * A call that fails is an error the agent reads, never a failed node. A tool must be
 * safe to rerun, because a retried attempt starts the node over.
 *
 * The `script_tool_call` event is a record of the call, written like the run's other
 * observability events: resume does not read it, and a write that fails is logged by the
 * store without changing what the agent gets back.
 */
import { nativeToolInputSchema, type NativeTool } from '@archon/provider-contract';
import { redactCredentialValues } from '@archon/paths/credential-redaction';
import type { AgentNode, ExecNode } from '../../../schemas';
import type { NodeExecutionRecord } from '../../../schemas/node-execution';
import { canonicalValueText, type JsonValue } from '../../../output-ref';
import { validateJsonSchema } from '../../../structured-output';
import type { RawSubprocessRejection } from '../../../subprocess';
import { formatSubprocessFailure } from '../../../executor-shared';
import type { RunLayersContext } from '../../run-context';
import { prepareToolScript, runScript } from '../exec/script';
import { ExecOutputContractError } from '../exec/exec-output';

type ToolOutcome = { status: 'completed'; output: JsonValue } | { status: 'failed'; error: string };

/**
 * Resolve every declared tool's script before the provider is called.
 * @throws when a script cannot be resolved, so the node fails without model spend.
 */
export async function createScriptTools(
  ctx: RunLayersContext,
  node: AgentNode,
  execution: NodeExecutionRecord
): Promise<NativeTool[]> {
  const declared = Object.entries(node.tools ?? {});
  return Promise.all(
    declared.map(async ([name, tool]): Promise<NativeTool> => {
      const script: ExecNode = {
        id: node.id,
        kind: 'exec',
        runtime: 'bun',
        script: tool.script,
        output_format: tool.output_schema,
        timeout: tool.timeout,
        deps: tool.deps,
      };
      const prepared = await prepareToolScript(ctx, script, execution);
      const run = async (input: Record<string, unknown>): Promise<ToolOutcome> => {
        const validation = validateJsonSchema(input, tool.input_schema);
        if (!validation.valid)
          return { status: 'failed', error: `Invalid input: ${validation.errors.join('; ')}` };
        try {
          const invocation = { ...prepared.invocation, input: JSON.stringify(input) };
          const result = await runScript(ctx, script, invocation, prepared.env);
          // A declared output is always certified; `null` is a valid certified value.
          const { structuredOutput, output } = result;
          return {
            status: 'completed',
            output: structuredOutput === undefined ? output : structuredOutput,
          };
        } catch (cause) {
          const error =
            cause instanceof ExecOutputContractError
              ? cause.message
              : formatSubprocessFailure(cause as RawSubprocessRejection, `Tool '${name}'`)
                  .userMessage;
          return { status: 'failed', error };
        }
      };
      return {
        name,
        description: tool.description,
        inputSchema: nativeToolInputSchema.parse({ jsonSchema: tool.input_schema }),
        handler: async (input, call) => {
          const outcome = await run(input);
          const { status, ...result } = outcome;
          await ctx.deps.store.createWorkflowEvent({
            workflow_run_id: ctx.workflowRun.id,
            step_name: execution.path,
            event_type: 'script_tool_call',
            data: {
              attempt_id: execution.attempt.id,
              tool_name: name,
              ...(call ? { provider_call_id: call.providerCallId } : {}),
              status,
              ...redacted({ input, ...result }, prepared.credentialValues),
            },
          });
          if (outcome.status === 'failed') throw new Error(outcome.error);
          return canonicalValueText(outcome.output);
        },
      };
    })
  );
}

/**
 * What the model sent and what the script returned, with credential values removed.
 * Redaction runs once over the serialized text, so a value inside a key, a nested string
 * or a number is covered. If a replacement leaves text that is no longer JSON (a numeric
 * credential inside a longer number), the redacted text is recorded as it is.
 */
function redacted(
  fields: Record<string, unknown>,
  credentialValues: readonly string[]
): Record<string, unknown> {
  // A value with a quote or backslash in it is serialized escaped; match that form too.
  const values = credentialValues
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  const text = redactCredentialValues(JSON.stringify(fields), values);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { redacted_text: text };
  }
}
