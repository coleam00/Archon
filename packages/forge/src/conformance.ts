import type { EventActionCapability, ForgeSourceCapabilities } from './capabilities';
import type { ForgeEventEnvelope } from './events';

export interface ForgeSourceConformanceFixture {
  name: string;
  capability: EventActionCapability;
}

/** The source owns its fixture inputs; this runner checks only the normalized contract. */
export function verifyForgeSourceConformance<T extends ForgeSourceConformanceFixture>(
  capabilities: ForgeSourceCapabilities,
  fixtures: readonly T[],
  normalize: (
    fixture: T
  ) =>
    | { status: 'normalized'; envelope: ForgeEventEnvelope }
    | { status: 'unsupported' | 'malformed'; reason: string }
): string[] {
  const failures: string[] = [];
  for (const fixture of fixtures) {
    const declared = capabilities.events.some(
      capability =>
        capability.kind === fixture.capability.kind &&
        capability.action === fixture.capability.action &&
        ('unitKind' in capability ? capability.unitKind : undefined) ===
          ('unitKind' in fixture.capability ? fixture.capability.unitKind : undefined)
    );
    const result = normalize(fixture);
    if (!declared) failures.push(`${fixture.name}: capability is not declared`);
    else if (result.status !== 'normalized')
      failures.push(`${fixture.name}: ${result.status} (${result.reason})`);
    else if (
      result.envelope.event.kind !== fixture.capability.kind ||
      result.envelope.event.action !== fixture.capability.action
    )
      failures.push(
        `${fixture.name}: normalized to ${result.envelope.event.kind}/${result.envelope.event.action}`
      );
    else if (
      result.envelope.event.kind === 'check.changed' &&
      fixture.capability.kind === 'check.changed' &&
      result.envelope.event.unit.kind !== fixture.capability.unitKind
    )
      failures.push(`${fixture.name}: normalized to ${result.envelope.event.unit.kind}`);
  }
  return failures;
}

export {
  runForgeReadConformance,
  runForgeMutationConformance,
  type ForgeReadConformanceCase,
  type ForgeMutationConformanceCase,
} from './outbound-conformance';
