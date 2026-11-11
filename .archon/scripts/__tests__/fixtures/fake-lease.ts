/**
 * Whether the fake CLI reports a lease live, from its holder's status in the test's
 * status table; a run with no status there counts as deleted. A conformance test in
 * `scripts/sdlc-output-conformance.test.ts` holds this to the engine's rule.
 */
export function fakeLeaseLive(status: string | undefined): boolean {
  return status !== undefined && status !== 'completed' && status !== 'cancelled';
}
