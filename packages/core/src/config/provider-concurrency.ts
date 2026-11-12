/**
 * Install-wide concurrency numbers in `~/.archon/config.yaml`: provider caps
 * (`concurrency.providers.<id>` and Pi `assistants.pi.maxConcurrent`) and resource
 * capacities (`concurrency.resources.<resource>`).
 *
 * Read fresh at every provider attempt and every resource admission, so changing a number
 * takes effect for the next admission without a restart. Unlike `loadGlobalConfig`, which
 * logs a broken file and carries on with defaults, these readers throw: a limit that
 * silently disappears would let an operator's limit fail open.
 */
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { configSchemas as piConfigSchemas } from '@archon/providers/pi/config';
import { isRegisteredProvider } from '@archon/providers';

export class ProviderConcurrencyConfigError extends Error {
  constructor(configPath: string, detail: string, refused = 'Provider attempts') {
    super(
      `Invalid concurrency config in '${configPath}': ${detail}. ` +
        `${refused} are refused until the config is fixed.`
    );
    this.name = 'ProviderConcurrencyConfigError';
  }
}

// Only the concurrency paths are strict; every other key belongs to the ordinary config
// loader. `.nullish()`: YAML reads an empty `concurrency:`, `providers:` or `resources:`
// key as null, which means no numbers, not an invalid config.
const configSchema = z.looseObject({
  assistants: z
    .looseObject({
      pi: z.looseObject({ maxConcurrent: piConfigSchemas.install.shape.maxConcurrent }).nullish(),
    })
    .nullish(),
  concurrency: z
    .looseObject({
      providers: z.record(z.string(), z.number().int().min(1)).nullish(),
      resources: z.record(z.string(), z.number().int().min(1)).nullish(),
    })
    .nullish(),
});

async function readConcurrencyConfig(refused: string): Promise<z.infer<typeof configSchema>> {
  const configPath = getArchonConfigPath();
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ProviderConcurrencyConfigError(configPath, (error as Error).message, refused);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (error) {
    throw new ProviderConcurrencyConfigError(configPath, (error as Error).message, refused);
  }
  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ProviderConcurrencyConfigError(configPath, detail, refused);
  }
  return result.data;
}

/** Caps keyed by provider registration ID. An absent provider is unlimited. */
export async function loadProviderConcurrencyCaps(): Promise<ReadonlyMap<string, number>> {
  const config = await readConcurrencyConfig('Provider attempts');
  const caps = new Map(Object.entries(config.concurrency?.providers ?? {}));
  const piCap = config.assistants?.pi?.maxConcurrent;
  if (piCap !== undefined) caps.set('pi', Math.min(caps.get('pi') ?? piCap, piCap));
  const unknown = [...caps.keys()].filter(id => !isRegisteredProvider(id));
  if (unknown.length > 0) {
    throw new ProviderConcurrencyConfigError(
      getArchonConfigPath(),
      `unknown provider registration ID(s) ${unknown.map(id => `'${id}'`).join(', ')}`
    );
  }
  return caps;
}

/** Resource capacities keyed by resource name. They win over any capacity a start declares. */
export async function loadResourceCapacities(): Promise<ReadonlyMap<string, number>> {
  const config = await readConcurrencyConfig('Resource admissions');
  return new Map(Object.entries(config.concurrency?.resources ?? {}));
}
