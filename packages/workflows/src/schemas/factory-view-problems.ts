/**
 * How a factory view's source fields word a failure, naming the key to fix (`factory-view.ts`
 * owns the shapes). Split from `factory-view.ts` for size.
 */
import { z } from 'zod';

export const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Why `input` is not a `schema` (a source called `kind`), naming the key to fix. A failed
 * union reports only "Invalid input", which leaves a view file's author nothing to act on.
 */
export function sourceProblem(kind: string, schema: z.ZodType, input: unknown): string {
  if (!isRecord(input)) return `expected ${kind}`;
  const issues = schema.safeParse(input).error?.issues ?? [];
  // A misspelt key is the cause of the missing one it was meant to be: name it first.
  const issue = issues.find(entry => entry.code === 'unrecognized_keys') ?? issues[0];
  if (issue === undefined) return `${kind} is invalid`;
  if (issue.code === 'unrecognized_keys')
    return `${kind} does not take ${issue.keys.map(key => `\`${key}\``).join(', ')}`;
  const key = String(issue.path[0]);
  return input[key] === undefined
    ? `${kind} needs \`${key}\``
    : `${kind}'s \`${key}\`: ${issue.message}`;
}

/**
 * One source, or a non-empty list of them. A failure names the entry and the key, as
 * "entry 1: a stage-form rounds source { workflow, round, allowance } needs `round`".
 */
export function oneOrList<T extends z.ZodType>(source: T, problem: (input: unknown) => string) {
  return z.union([source, z.array(source).min(1)], {
    error: issue => {
      const { input } = issue;
      if (!Array.isArray(input)) return problem(input);
      if (input.length === 0) return 'a list names at least one source';
      const bad = input.findIndex(entry => !source.safeParse(entry).success);
      return bad === -1 ? 'is invalid' : `entry ${String(bad)}: ${problem(input[bad])}`;
    },
  });
}
