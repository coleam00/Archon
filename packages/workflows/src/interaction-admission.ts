/** A loop iteration settles sibling work before publishing an interaction. */
export interface InteractionAdmission {
  failure(): string | undefined;
  failed(origin: string): void;
  beforeInteraction(): Promise<void>;
}

export function loopBodyAdmission(parent: InteractionAdmission | undefined): InteractionAdmission {
  if (parent !== undefined) return parent;
  let reportedFailure: string | undefined;
  return {
    failure: () => reportedFailure,
    failed(origin) {
      reportedFailure ??= origin;
    },
    beforeInteraction: () => Promise.resolve(),
  };
}

/**
 * Each sibling either finishes or parks at its first interaction. A nested layer
 * parks its enclosing sibling only after all of its own siblings have reached that
 * boundary. No persisted pause is needed to discover a peer's failure.
 */
export function peerAdmissions(parent: InteractionAdmission, count: number) {
  const ready = Array.from({ length: count }, () => Promise.withResolvers<void>());
  const allReady = Promise.all(ready.map(entry => entry.promise));
  return ready.map(entry => ({
    finished: () => entry.resolve(),
    admission: {
      failure: () => parent.failure(),
      failed: (origin: string) => parent.failed(origin),
      async beforeInteraction() {
        entry.resolve();
        await allReady;
        await parent.beforeInteraction();
      },
    } satisfies InteractionAdmission,
  }));
}
