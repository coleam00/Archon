import type { WorkflowRun } from './workflow-run';

export type RunCheckout = Pick<WorkflowRun, 'codebase_id' | 'metadata'> & {
  working_path?: string | null;
};

type CheckoutRun = Pick<WorkflowRun, 'working_path' | 'metadata'>;

export function checkoutEnvironmentReferences(
  metadata: Record<string, unknown>
): readonly [environmentId: unknown, ownedId: unknown] {
  const owned = metadata.owned_worktree;
  return [
    metadata.isolation_env_id,
    owned && typeof owned === 'object' && 'envId' in owned ? owned.envId : null,
  ];
}

export function introducesCheckout(
  prior: CheckoutRun | null | undefined,
  next: CheckoutRun
): boolean {
  const previous = checkoutEnvironmentReferences(prior?.metadata ?? {});
  return (
    (next.working_path !== null && next.working_path !== prior?.working_path) ||
    checkoutEnvironmentReferences(next.metadata).some(
      (id, index) => typeof id === 'string' && id !== previous[index]
    )
  );
}

export class CheckoutReleasedError extends Error {
  constructor(readonly path: string) {
    super(`Checkout '${path}' was released; start a fresh run.`);
    this.name = 'CheckoutReleasedError';
  }
}
