/**
 * Install-wide provider concurrency caps (`concurrency.providers.<id>` and Pi
 * `assistants.pi.maxConcurrent` in `~/.archon/config.yaml`), read fresh at every provider
 * attempt through `readConcurrencyConfig`. The schema and `providerCapsOf` are also what a
 * settings write checks, so a write cannot save caps that admission then refuses.
 */
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { configSchemas as piConfigSchemas } from '@archon/providers/pi/config';
import { isRegisteredProvider } from '@archon/providers';
import { ConcurrencyConfigError, readConcurrencyConfig } from './concurrency-config';

const REFUSED = 'Provider attempts';

// `.nullish()`: YAML reads an empty `concurrency:` or `providers:` key as null, which
// means no caps, not an invalid config.
export const providerConcurrencySchema = z.looseObject({
  assistants: z
    .looseObject({
      pi: z.looseObject({ maxConcurrent: piConfigSchemas.install.shape.maxConcurrent }).nullish(),
    })
    .nullish(),
  concurrency: z
    .looseObject({ providers: z.record(z.string(), z.number().int().min(1)).nullish() })
    .nullish(),
});

/**
 * Caps keyed by provider registration ID, with Pi's `maxConcurrent` folded in as the lower
 * of the two, and the IDs no registered provider owns.
 */
export function providerCapsOf(config: z.output<typeof providerConcurrencySchema>): {
  caps: Map<string, number>;
  unknown: string[];
} {
  const caps = new Map(Object.entries(config.concurrency?.providers ?? {}));
  const piCap = config.assistants?.pi?.maxConcurrent;
  if (piCap !== undefined) caps.set('pi', Math.min(caps.get('pi') ?? piCap, piCap));
  return { caps, unknown: [...caps.keys()].filter(id => !isRegisteredProvider(id)) };
}

export function unknownProvidersDetail(unknown: readonly string[]): string {
  return `unknown provider registration ID(s) ${unknown.map(id => `'${id}'`).join(', ')}`;
}

/** Caps keyed by provider registration ID. An absent provider is unlimited. */
export async function loadProviderConcurrencyCaps(): Promise<ReadonlyMap<string, number>> {
  const { caps, unknown } = providerCapsOf(
    await readConcurrencyConfig(providerConcurrencySchema, REFUSED)
  );
  if (unknown.length > 0) {
    throw new ConcurrencyConfigError(
      getArchonConfigPath(),
      unknownProvidersDetail(unknown),
      REFUSED
    );
  }
  return caps;
}
