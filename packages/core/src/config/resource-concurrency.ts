import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { resourceCapacitySchema, resourceNameSchema } from '@archon/workflows/schemas/resource';

export class ResourceConcurrencyConfigError extends Error {
  constructor(configPath: string, detail: string) {
    super(
      `Invalid resource concurrency config in '${configPath}': ${detail}. ` +
        'Resource admissions are refused until the config is fixed.'
    );
    this.name = 'ResourceConcurrencyConfigError';
  }
}

export const resourceConcurrencySchema = z.record(resourceNameSchema, resourceCapacitySchema);

const configSchema = z.looseObject({
  concurrency: z.looseObject({ resources: resourceConcurrencySchema.nullish() }).nullish(),
});

/** Install-only overrides, read fresh so config edits affect the next admission. */
export async function loadResourceConcurrencyCaps(): Promise<ReadonlyMap<string, number>> {
  const configPath = getArchonConfigPath();
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    throw new ResourceConcurrencyConfigError(configPath, String(error));
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (error) {
    throw new ResourceConcurrencyConfigError(configPath, String(error));
  }
  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new ResourceConcurrencyConfigError(
      configPath,
      result.error.issues
        .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
    );
  }
  return new Map(Object.entries(result.data.concurrency?.resources ?? {}));
}
