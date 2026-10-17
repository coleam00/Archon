/**
 * Install-wide provider concurrency caps (`concurrency.providers.<id>` and Pi
 * `assistants.pi.maxConcurrent` in
 * `~/.archon/config.yaml`).
 *
 * Read fresh at every provider attempt, so lowering a cap takes effect for the next
 * admission without a restart. Unlike `loadGlobalConfig`, which logs a broken file and
 * carries on with defaults, this reader throws: a cap that silently disappears would
 * let an operator's limit fail open.
 */
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { configSchemas as piConfigSchemas } from '@archon/providers/pi/config';
import { isRegisteredProvider } from '@archon/providers';

export class ProviderConcurrencyConfigError extends Error {
  constructor(configPath: string, detail: string) {
    super(
      `Invalid provider concurrency config in '${configPath}': ${detail}. ` +
        'Provider attempts are refused until the provider cap is fixed.'
    );
    this.name = 'ProviderConcurrencyConfigError';
  }
}

// Only cap paths are strict; every other key belongs to the ordinary config loader.
// `.nullish()`: YAML reads an empty `concurrency:` or `providers:` key as null, which
// means no caps, not an invalid config.
const configSchema = z.looseObject({
  assistants: z
    .looseObject({
      pi: z.looseObject({ maxConcurrent: piConfigSchemas.install.shape.maxConcurrent }).nullish(),
    })
    .nullish(),
  concurrency: z
    .looseObject({ providers: z.record(z.string(), z.number().int().min(1)).nullish() })
    .nullish(),
});

/** Caps keyed by provider registration ID. An absent provider is unlimited. */
export async function loadProviderConcurrencyCaps(): Promise<ReadonlyMap<string, number>> {
  const configPath = getArchonConfigPath();
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new ProviderConcurrencyConfigError(configPath, (error as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (error) {
    throw new ProviderConcurrencyConfigError(configPath, (error as Error).message);
  }
  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ProviderConcurrencyConfigError(configPath, detail);
  }
  const caps = new Map(Object.entries(result.data.concurrency?.providers ?? {}));
  const piCap = result.data.assistants?.pi?.maxConcurrent;
  if (piCap !== undefined) caps.set('pi', Math.min(caps.get('pi') ?? piCap, piCap));
  const unknown = [...caps.keys()].filter(id => !isRegisteredProvider(id));
  if (unknown.length > 0) {
    throw new ProviderConcurrencyConfigError(
      configPath,
      `unknown provider registration ID(s) ${unknown.map(id => `'${id}'`).join(', ')}`
    );
  }
  return caps;
}
