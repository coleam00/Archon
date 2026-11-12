import type { ChatActor } from '@archon/chat-contract';
import type { AttentionAnswerer } from '@archon/workflows/schemas/workflow-run';
import type { UserRole } from '../schemas/user';

/**
 * Who acts on a run. `declared` is the name an operator-side answerer gave for itself
 * (`--as`): a claim recorded with an answer, which nothing checks and authorization
 * never reads.
 */
export type RunActor = { kind: 'operator'; declared?: string } | ChatActor;

/** Who an answer by `actor` is recorded as coming from, when the actor says. */
export function answererOf(actor: RunActor): AttentionAnswerer | undefined {
  switch (actor.kind) {
    case 'operator':
      return actor.declared === undefined ? undefined : { declared: actor.declared };
    case 'user':
      return { userId: actor.userId };
    case 'unidentified':
      return undefined;
  }
}

export const RUN_ACTIONS = [
  'approve',
  'reject',
  'respond',
  'cancel',
  'abandon',
  'resume',
  'signal',
  'delete',
] as const;

export type RunAction = (typeof RUN_ACTIONS)[number];

export function authorizeRunAction(
  actor: RunActor,
  starterUserId: string | null,
  actorRole: UserRole | undefined
): boolean {
  return (
    actor.kind === 'operator' ||
    (actor.kind === 'user' && (actorRole === 'admin' || actor.userId === starterUserId))
  );
}

export class RunActionForbiddenError extends Error {
  constructor(
    readonly action: RunAction,
    starterUserId: string | null | undefined
  ) {
    const verb = action === 'respond' ? 'respond to' : action;
    super(
      (starterUserId === null
        ? `This run has no recorded starter; only an admin can ${verb} it.`
        : `Only the user who started this run or an admin can ${verb} it.`) +
        ' An operator can grant admin with `archon user role <user-id> admin`.'
    );
    this.name = 'RunActionForbiddenError';
  }
}
