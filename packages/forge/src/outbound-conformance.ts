import { matchesForgeOperationResponse } from './dispatch';
import {
  forgeResponseSchema,
  mutationTarget,
  type ChecksState,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
} from './operations';

export interface ForgeReadConformanceCase {
  name: string;
  request: Extract<ForgeRequest, { op: 'checks.state' }>;
  expected: {
    revision: string;
    state: ChecksState;
    units: readonly { kind: 'check' | 'commit_status'; id: string }[];
  };
}

/** Run an adapter's controlled repository fixtures through its real operation boundary. */
export async function runForgeReadConformance(
  invoke: (request: ForgeRequest) => Promise<ForgeResponse>,
  cases: readonly ForgeReadConformanceCase[]
): Promise<string[]> {
  const failures: string[] = [];
  for (const fixture of cases) {
    const parsed = forgeResponseSchema.safeParse(await invoke(fixture.request));
    if (!parsed.success || !parsed.data.ok || parsed.data.result.op !== 'checks.state') {
      failures.push(`${fixture.name}: no valid check observation`);
      continue;
    }
    const response = parsed.data;
    const value = parsed.data.result.value;
    if (
      response.operationId !== fixture.request.operationId ||
      value.ref.number !== fixture.request.ref.number ||
      value.ref.repo.host !== fixture.request.ref.repo.host ||
      value.ref.repo.path !== fixture.request.ref.repo.path ||
      value.revision !== fixture.expected.revision ||
      value.summary.state !== fixture.expected.state
    ) {
      failures.push(`${fixture.name}: correlation, target, revision or state differs`);
    }
    const identities = value.units.map(unit => `${unit.unit.kind}:${unit.unit.id}`).sort();
    const expected = fixture.expected.units.map(unit => `${unit.kind}:${unit.id}`).sort();
    if (JSON.stringify(identities) !== JSON.stringify(expected))
      failures.push(`${fixture.name}: enumerated unit identities differ`);
  }
  return failures;
}

export interface ForgeMutationConformanceCase {
  name: string;
  request: ForgeMutationRequest;
  expectedOutcome: 'applied' | ForgeMutationFailure['outcome'];
}

/**
 * Run an adapter's controlled mutation fixtures through its real operation
 * boundary. The fixture owns the remote state; this runner checks only that the
 * public evidence answers the request and names the outcome the fixture set up.
 */
export async function runForgeMutationConformance(
  invoke: (request: ForgeMutationRequest) => Promise<ForgeResponse>,
  metadata: PluginMetadata,
  cases: readonly ForgeMutationConformanceCase[]
): Promise<string[]> {
  const failures: string[] = [];
  for (const fixture of cases) {
    const target = mutationTarget(fixture.request);
    const host = 'repo' in target ? target.repo.host : target.host;
    const parsed = forgeResponseSchema.safeParse(await invoke(fixture.request));
    if (
      !parsed.success ||
      parsed.data.operationId !== fixture.request.operationId ||
      !matchesForgeOperationResponse(fixture.request, parsed.data, metadata, host)
    ) {
      failures.push(`${fixture.name}: invalid mutation correlation, target or read-back evidence`);
      continue;
    }
    const outcome = parsed.data.ok ? 'applied' : parsed.data.mutation?.outcome;
    if (outcome !== fixture.expectedOutcome)
      failures.push(
        `${fixture.name}: expected ${fixture.expectedOutcome}, received ${String(outcome)}`
      );
  }
  return failures;
}
