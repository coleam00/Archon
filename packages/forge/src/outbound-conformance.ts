import {
  forgeResponseSchema,
  type ForgeRequest,
  type ForgeResponse,
  type ChecksState,
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
