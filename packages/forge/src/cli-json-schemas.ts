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
  const requests = [
    ...forgeRequestSchema.options,
    cliForgeMetadataRequestSchema,
    cliForgeCheckRequestSchema,
  ];
  return {
    operations: requests.map(request => {
      const op = request.shape.op.value;
      const result = results.get(op);
      if (!result) throw new Error(`forge operation ${op} declares no result schema`);
      // What a caller writes, before defaults and transforms; what it reads, after them.
      const { properties = {}, required = [], ...rest } = z.toJSONSchema(request, { io: 'input' });
      return {
        op,
        request: {
          ...rest,
          properties: Object.fromEntries(
            Object.entries(properties).filter(([name]) => !HOST_SUPPLIED.includes(name))
          ),
          required: required.filter(name => !HOST_SUPPLIED.includes(name)),
        },
        result: z.toJSONSchema(result, { io: 'output' }),
      };
    }),
    success: z.toJSONSchema(success.omit({ result: true }), { io: 'output' }),
    failure: z.toJSONSchema(failure, { io: 'output' }),
  };
}
