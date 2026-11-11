/**
 * Whether the fake CLI reports a lease live, from its holder's status in the test's
 * status table; a run with no status there counts as deleted. A conformance test in
 * `scripts/sdlc-output-conformance.test.ts` holds every rule in this file to the engine's.
 */
export function fakeLeaseLive(status: string | undefined): boolean {
  return status !== undefined && status !== 'completed' && status !== 'cancelled';
}

/**
 * Whether the fake CLI lets the calling run take or give back a document's lease, as
 * `state claim`, `--lease` and `--release-lease` do: nobody holds it, the run holds it
 * itself, or its holder's lease has ended.
 */
export function fakeLeaseFree(holder: string | undefined, self: string, holderLive: boolean): boolean {
  return holder === undefined || holder === self || !holderLive;
}

/** Whether the fake CLI makes the calling run's `--held` write: the run holds the document's lease. */
export function fakeLeaseHeld(holder: string | undefined, self: string): boolean {
  return holder === self;
}
