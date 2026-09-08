import {
  checksVerdictSchema,
  pluginMetadataSchema,
  forgeOpErrorSchema,
  CHECKS,
  emptyCounts,
  FORGE_PROTOCOL_VERSION,
  type ChecksState,
  type ChecksVerdict,
} from './schemas';
import { externalPluginHandle } from './dispatch/plugin-handle';
import type { PluginCandidate } from './dispatch/exec';
import { isDeepStrictEqual } from 'node:util';
export { pluginMetadataSchema, checksVerdictSchema, forgeOpErrorSchema };
export const NON_ASCII_ROUNDTRIP_FIXTURE = 'Rocket 🚀, combining é, literal \\r\\n';
export function checksVerdictFixture(state: ChecksState): ChecksVerdict {
  const counts = emptyCounts();
  const units: ChecksVerdict['units'] = [];
  if (state !== CHECKS.none) {
    counts.total = 1;
    counts[state] = 1;
    units.push({ name: NON_ASCII_ROUNDTRIP_FIXTURE, source: 'native', state });
  }
  return { state, counts, units, head_sha: 'a'.repeat(40) };
}
/** Runs the real executable boundary; authors supply fixture requests and expected responses. */
export async function checkPluginConformance(
  candidate: PluginCandidate,
  cases: { op: string; request: unknown; expected: unknown }[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const handle = externalPluginHandle(candidate, { env });
  const metadata = await handle.metadata();
  if (metadata.kind !== 'ok' || metadata.value.protocol !== FORGE_PROTOCOL_VERSION)
    throw new Error('Plugin metadata failed conformance');
  for (const fixture of cases) {
    const result = await handle.execOp(fixture.op, fixture.request, env);
    if (
      !metadata.value.capabilities.includes(fixture.op) ||
      result.kind !== 'ok' ||
      !isDeepStrictEqual(result.value, fixture.expected)
    ) {
      throw new Error(`Plugin conformance failed for ${fixture.op}`);
    }
  }
}
