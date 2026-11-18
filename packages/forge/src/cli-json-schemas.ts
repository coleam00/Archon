import { z } from 'zod';
import {
  cliForgeCheckRequestSchema,
  cliForgeMetadataRequestSchema,
  cliForgeResponseSchema,
} from './cli-response';
import { forgeRequestSchema } from './operations';

/**
 * JSON Schema of what `archon forge <operation> --json` reads and writes, for a generator
 * that states it in another language. The zod schemas the host parses with stay the owner.
 */
export interface CliForgeJsonSchemas {
  /** Per operation: the `--data` object (the host supplies `op` and `operationId`) and the result's `value`. */
  readonly operations: readonly {
    readonly op: string;
    readonly request: unknown;
    readonly result: unknown;
  }[];
  /** The success envelope without its `result`. */
  readonly success: unknown;
  readonly failure: unknown;
}

const HOST_SUPPLIED = ['op', 'operationId'];

export function cliForgeJsonSchemas(): CliForgeJsonSchemas {
  const [success, failure] = cliForgeResponseSchema.options;
  const [operationResults, ...hostResults] = success.shape.result.options;
  const results = new Map<string, z.ZodType>(
    [...operationResults.options, ...hostResults].map(result => [
      result.shape.op.value,
      result.shape.value,
    ])
  );
  const requests: [string, z.ZodType][] = [
    ...[...forgeRequestSchema.options, cliForgeMetadataRequestSchema].map(
      request => [request.shape.op.value, request] as [string, z.ZodType]
    ),
    // Exclusive alternatives, each an object that names the same op.
    [cliForgeCheckRequestSchema.options[0].shape.op.value, cliForgeCheckRequestSchema],
  ];
  return {
    operations: requests.map(([op, request]) => {
      const result = results.get(op);
      if (!result) throw new Error(`forge operation ${op} declares no result schema`);
      return {
        op,
        // What a caller writes, before defaults and transforms; what it reads, after them.
        request: callerWritten(z.toJSONSchema(request, { io: 'input' })),
        result: z.toJSONSchema(result, { io: 'output' }),
      };
    }),
    success: z.toJSONSchema(success.omit({ result: true }), { io: 'output' }),
    failure: z.toJSONSchema(failure, { io: 'output' }),
  };
}

/** A request schema without the fields the host supplies, in each alternative. */
function callerWritten(schema: z.core.JSONSchema.BaseSchema): z.core.JSONSchema.BaseSchema {
  const { anyOf, properties, required, ...rest } = schema;
  if (anyOf) return { ...rest, anyOf: anyOf.map(callerWritten) };
  return {
    ...rest,
    properties: Object.fromEntries(
      Object.entries(properties ?? {}).filter(([name]) => !HOST_SUPPLIED.includes(name))
    ),
    required: (required ?? []).filter(name => !HOST_SUPPLIED.includes(name)),
  };
}
