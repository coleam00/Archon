/**
 * Install-wide provider concurrency caps (`concurrency.providers.<id>` and Pi
 * `assistants.pi.maxConcurrent` in `~/.archon/config.yaml`), read fresh at every provider
 * attempt through `readConcurrencyConfig`. A settings write checks the same rules through
 * `resolveProviderConcurrencyCaps` before it saves.
 */
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { configSchemas as piConfigSchemas } from '@archon/providers/pi/config';
import { isRegisteredProvider } from '@archon/providers';
import {
  ConcurrencyConfigError,
  describeIssues,
  readConcurrencyConfig,
} from './concurrency-config';

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

type ProviderConcurrencyCaps =
  | { ok: true; caps: ReadonlyMap<string, number> }
  | { ok: false; detail: string };

/**
 * Caps keyed by provider registration ID from a parsed config, or the keys that make it
 * invalid. An absent provider is unlimited.
 */
export function resolveProviderConcurrencyCaps(config: unknown): ProviderConcurrencyCaps {
  const result = configSchema.safeParse(config ?? {});
  if (!result.success) {
    return { ok: false, detail: describeIssues(result.error) };
  }
  const { data } = result;
  const caps = new Map(Object.entries(data.concurrency?.providers ?? {}));
  const piCap = data.assistants?.pi?.maxConcurrent;
  if (piCap !== undefined) caps.set('pi', Math.min(caps.get('pi') ?? piCap, piCap));
  const unknown = [...caps.keys()].filter(id => !isRegisteredProvider(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      detail: `unknown provider registration ID(s) ${unknown.map(id => `'${id}'`).join(', ')}`,
    };
  }
  return { ok: true, caps };
}

/** The caps admission enforces; a broken file or cap throws, refusing provider attempts. */
export async function loadProviderConcurrencyCaps(): Promise<ReadonlyMap<string, number>> {
  const resolved = resolveProviderConcurrencyCaps(
    await readConcurrencyConfig(z.unknown(), REFUSED)
  );
  if (!resolved.ok)
    throw new ConcurrencyConfigError(getArchonConfigPath(), resolved.detail, REFUSED);
  return resolved.caps;
}
