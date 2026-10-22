/**
 * The terminating `structured_output` tool a Pi node with `output_format`
 * answers through. Its parameters are the node's schema unchanged, so Pi
 * validates a call's arguments before `execute` and hands a failure back to
 * the model in-session; a valid call ends the turn without another model call.
 *
 * Imports Pi SDK values, so ./turn.ts loads it dynamically (see the lazy-load
 * note in ./provider.ts).
 */
import { createLogger } from '@archon/paths';
import { Type, validateToolArguments } from '@earendil-works/pi-ai';
import {
  defineTool,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { ClassifiedProviderError } from '../../shared/failure';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/**
 * Pi does not cap a tool's failed calls: a model that keeps sending invalid
 * arguments loops until something stops it.
 */
const MAX_FAILED_CALLS = 3;

type FinishTurn = NonNullable<AgentSession['agent']['finishTurn']>;

export interface PiStructuredOutputTool {
  definition: ToolDefinition;
  /** Arguments of the last valid call; undefined when the model made none. */
  output(): Record<string, unknown> | undefined;
  /**
   * End the session's agent loop once the model has made `MAX_FAILED_CALLS`
   * invalid calls, leaving no output so the engine's own reask path runs.
   */
  capFailedCalls(session: Pick<AgentSession, 'agent'>): void;
}

export function createStructuredOutputTool(
  schema: Record<string, unknown>
): PiStructuredOutputTool {
  assertRepresentable(schema);
  let output: Record<string, unknown> | undefined;
  const definition = defineTool({
    name: STRUCTURED_OUTPUT_TOOL,
    label: STRUCTURED_OUTPUT_TOOL,
    description:
      'Return your final answer as structured data. Call this exactly once, as your last action, with arguments matching the required schema.',
    parameters: Type.Unsafe<Record<string, unknown>>(schema),
    // Ask for provider-side constrained sampling where the backend and schema allow
    // it; `prefer` falls back to an unconstrained tool rather than failing the request.
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    execute: async (_toolCallId, params) => {
      output = params;
      return {
        content: [{ type: 'text', text: 'Structured output recorded.' }],
        details: undefined,
        terminate: true,
      };
    },
  });

  return {
    definition,
    output: () => output,
    capFailedCalls(session) {
      const { agent } = session;
      const previous = agent.finishTurn;
      let failedCalls = 0;
      const finishTurn: FinishTurn = async (turn, signal) => {
        // The session's own finishTurn dispatches extension turn_end handlers; it runs first.
        const decision = (await previous?.(turn, signal)) ?? undefined;
        failedCalls += turn.toolResults.filter(
          result => result.toolName === STRUCTURED_OUTPUT_TOOL && result.isError
        ).length;
        if (failedCalls < MAX_FAILED_CALLS) return decision;
        getLog().warn({ failedCalls }, 'pi.structured_output_failed_call_cap_reached');
        return { action: 'end' };
      };
      agent.finishTurn = finishTurn;
    },
  };
}

/**
 * Tool arguments are a JSON object, so the schema root must declare one. Pi
 * compiles a tool's schema lazily, on the first call's validation; validating
 * an always-valid probe against `anyOf: [{}, schema]` forces that compile now,
 * so only a schema Pi's compiler rejects can throw here.
 */
function assertRepresentable(schema: Record<string, unknown>): void {
  if (schema.type !== 'object') {
    throw new ClassifiedProviderError(
      'misconfigured',
      'Pi answers output_format through a tool call, whose arguments are a JSON object: ' +
        'declare `type: object` at the root of the output_format schema.'
    );
  }
  try {
    validateToolArguments(
      {
        name: STRUCTURED_OUTPUT_TOOL,
        description: '',
        parameters: Type.Unsafe({ anyOf: [{}, schema] }),
      },
      { type: 'toolCall', id: 'schema-compile', name: STRUCTURED_OUTPUT_TOOL, arguments: {} }
    );
  } catch (err) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Pi cannot compile the output_format schema for its structured_output tool: ${(err as Error).message}`
    );
  }
}

/**
 * Ask for the answer through the tool. The JSON-in-text instruction is only the
 * fallback for a model that cannot call tools; the bridge scrapes the reply
 * text for it, never the thinking.
 */
export function augmentPromptForStructuredOutput(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

Deliver your final answer by calling the \`${STRUCTURED_OUTPUT_TOOL}\` tool exactly once, as your last action, with the answer as its arguments. Its parameters are the schema below. Only if you cannot call tools, reply instead with just a JSON object matching the schema, without prose or markdown code fences.

Schema:
${JSON.stringify(schema, null, 2)}`;
}
