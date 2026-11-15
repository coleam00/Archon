/**
 * The concurrency numbers in `~/.archon/config.yaml`: provider caps
 * (`provider-concurrency.ts`) and resource capacities (`concurrency.resources.<resource>`).
 *
 * Read fresh at every provider attempt and every resource admission, so changing a number
 * takes effect for the next admission without a restart. Unlike `loadGlobalConfig`, which
 * logs a broken file and carries on with defaults, these readers throw: a limit that
 * silently disappears would let an operator's limit fail open.
 */
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths/archon-paths';

export class ConcurrencyConfigError extends Error {
  constructor(configPath: string, detail: string, refused: string) {
    super(
      `Invalid concurrency config in '${configPath}': ${detail}. ` +
        `${refused} are refused until the config is fixed.`
    );
    this.name = 'ConcurrencyConfigError';
  }
}

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
