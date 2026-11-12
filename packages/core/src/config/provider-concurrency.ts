/**
 * Install-wide provider concurrency caps (`concurrency.providers.<id>` and Pi
 * `assistants.pi.maxConcurrent` in `~/.archon/config.yaml`), read fresh at every provider
 * attempt through `readConcurrencyConfig`.
 */
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { configSchemas as piConfigSchemas } from '@archon/providers/pi/config';
import { isRegisteredProvider } from '@archon/providers';
import { ConcurrencyConfigError, readConcurrencyConfig } from './concurrency-config';

const REFUSED = 'Provider attempts';

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
  const config = await readConcurrencyConfig(configSchema, REFUSED);
  const caps = new Map(Object.entries(config.concurrency?.providers ?? {}));
  const piCap = config.assistants?.pi?.maxConcurrent;
  if (piCap !== undefined) caps.set('pi', Math.min(caps.get('pi') ?? piCap, piCap));
  const unknown = [...caps.keys()].filter(id => !isRegisteredProvider(id));
  if (unknown.length > 0) {
    throw new ConcurrencyConfigError(
      getArchonConfigPath(),
      `unknown provider registration ID(s) ${unknown.map(id => `'${id}'`).join(', ')}`,
      REFUSED
    );
  }
  return caps;
}
