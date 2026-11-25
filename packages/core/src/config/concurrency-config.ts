/**
 * The concurrency numbers in `~/.archon/config.yaml`: provider caps
 * (`provider-concurrency.ts`), resource capacities (`concurrency.resources.<resource>`) and
 * the install's run limit (`concurrency.runs`).
 *
 * Read fresh at every provider attempt and every resource admission, so changing a number
 * takes effect for the next admission without a restart. A broken file or value throws, naming
 * the file, the key and what each caller refuses: a limit that silently disappeared would let
 * an operator's limit fail open.
 */
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths/archon-paths';
import { ConcurrencyConfigError } from '@archon/workflows/store';

export { ConcurrencyConfigError };

/**
 * The config file checked against `schema`, or `{}` when there is none. Only the
 * concurrency paths a schema names are strict; every other key belongs to the ordinary
 * config loader. `refused` names what the caller refuses while the file is broken.
 */
export async function readConcurrencyConfig<S extends z.ZodType>(
  schema: S,
  refused: string
): Promise<z.output<S>> {
  const configPath = getArchonConfigPath();
  const fail = (detail: string): ConcurrencyConfigError =>
    new ConcurrencyConfigError(configPath, detail, refused);
  let content: string | undefined;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail((error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = content === undefined ? {} : Bun.YAML.parse(content);
  } catch (error) {
    throw fail((error as Error).message);
  }
  const result = schema.safeParse(parsed ?? {});
  if (!result.success) {
    throw fail(
      result.error.issues
        .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
    );
  }
  return result.data;
}

// `.nullish()`: YAML reads an empty `concurrency:` or `resources:` key as null, which
// means no numbers, not an invalid config.
const resourcesSchema = z.looseObject({
  concurrency: z
    .looseObject({ resources: z.record(z.string(), z.number().int().min(1)).nullish() })
    .nullish(),
});

/** Resource capacities keyed by resource name. They win over any capacity a start declares. */
export async function loadResourceCapacities(): Promise<ReadonlyMap<string, number>> {
  const config = await readConcurrencyConfig(resourcesSchema, 'Resource admissions');
  return new Map(Object.entries(config.concurrency?.resources ?? {}));
}

const runsSchema = z.looseObject({
  concurrency: z.looseObject({ runs: z.number().int().min(1).nullish() }).nullish(),
});

/** How many run trees the install executes at once; undefined when no limit is set. */
export async function loadRunLimit(): Promise<number | undefined> {
  const config = await readConcurrencyConfig(runsSchema, 'Run admissions');
  return config.concurrency?.runs ?? undefined;
}
